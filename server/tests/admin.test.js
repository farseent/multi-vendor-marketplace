import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { Product } from '../src/modules/catalog/products.model.js';
import { Review } from '../src/modules/reviews/reviews.model.js';
import { SearchOutbox } from '../src/modules/search/search.model.js';
import { createMockLedger } from '../src/providers/payment/mockLedger.js';
import { clearDb, startTestDb, stopTestDb } from './db.js';
import { makeAdmin, makeCategory, makeVendor } from './factories.js';
import { createFakeRedis } from './fakeSearch.js';
import { buildTestApp } from './helpers.js';
import { addProduct, api, makeCustomerDirect } from './phase5.helpers.js';
import { deliver, paidOrder } from './phase6.helpers.js';

let replSet;
let app;
let ledger;
let redis;
let admin;
beforeAll(async () => {
  replSet = await startTestDb();
}, 60_000);
afterAll(() => stopTestDb(replSet));
beforeEach(async () => {
  await clearDb();
  ledger = createMockLedger();
  redis = createFakeRedis();
  app = buildTestApp({ paymentProvider: ledger, redis });
  admin = await makeAdmin(app);
});

const get = (path) => api(app, 'get', path, admin.auth);
const patch = (path, body) => api(app, 'patch', path, admin.auth, body);

describe('GET /admin/products', () => {
  async function market() {
    const category = await makeCategory();
    const a = await makeVendor(app, 'va@example.com', { approved: true, shopName: 'Alpha Shop' });
    const b = await makeVendor(app, 'vb@example.com', { approved: true, shopName: 'Beta Shop' });
    const kurta = await addProduct(app, a, category, { title: 'Cotton Kurta', sku: 'A-1' });
    const shirt = await addProduct(app, b, category, { title: 'Linen Shirt', sku: 'B-1' });
    const draft = await addProduct(app, b, category, {
      title: 'Draft Scarf',
      sku: 'B-2',
      status: 'draft',
    });
    return { a, b, kurta, shirt, draft };
  }

  it('lists every product of every shop (drafts included) with the shop, newest first', async () => {
    const m = await market();
    const res = await get('/admin/products');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 20, total: 3, totalPages: 1 });
    expect(res.body.data.map((p) => p.id)).toEqual([m.draft.id, m.shirt.id, m.kurta.id]);
    expect(res.body.data[2]).toMatchObject({
      title: 'Cotton Kurta',
      status: 'active',
      pricePaise: 10000,
      shop: { id: m.a.shop.id, name: 'Alpha Shop' },
    });
  });

  it('filters by status, shop and a title fragment; the fragment is literal, never a pattern', async () => {
    const m = await market();
    const ids = async (qs) => (await get(`/admin/products?${qs}`)).body.data.map((p) => p.id);
    expect(await ids('status=draft')).toEqual([m.draft.id]);
    expect(await ids(`vendorId=${m.a.shop.id}`)).toEqual([m.kurta.id]);
    expect(await ids('q=LINEN')).toEqual([m.shirt.id]);
    expect(await ids('q=.*')).toEqual([]); // would match everything if it were a regex
    expect((await get('/admin/products?limit=2&page=2')).body.data).toHaveLength(1);
  });

  it('rejects a bad status, a bad vendor id and a limit above 100 with 422', async () => {
    for (const qs of ['status=gone', 'vendorId=xyz', 'limit=101']) {
      expect((await get(`/admin/products?${qs}`)).status, qs).toBe(422);
    }
  });
});

describe('PATCH /admin/products/:id/status (D65)', () => {
  async function liveProduct() {
    const category = await makeCategory();
    const vendor = await makeVendor(app, 'v@example.com', { approved: true });
    const product = await addProduct(app, vendor, category);
    return { vendor, product };
  }

  it('suspends: hidden from the public page, re-indexed, cache dropped, audited in one go', async () => {
    const { product } = await liveProduct();
    expect((await request(app).get(`/api/v1/products/${product.slug}`)).status).toBe(200);
    expect(redis.store.has(`cache:product:${product.slug}`)).toBe(true);
    await SearchOutbox.deleteMany({});

    const res = await patch(`/admin/products/${product.id}/status`, { status: 'suspended' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      id: product.id,
      status: 'suspended',
      previousStatus: 'active',
    });

    expect((await request(app).get(`/api/v1/products/${product.slug}`)).status).toBe(404);
    expect(redis.store.has(`cache:product:${product.slug}`)).toBe(false);
    expect(await SearchOutbox.countDocuments({ productId: product.id })).toBe(1);

    const entries = await AuditLog.find({ action: 'product.status_changed' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorRole: 'admin', entityType: 'product' });
    expect(String(entries[0].entityId)).toBe(product.id);
    expect(entries[0].meta).toMatchObject({ from: 'active', to: 'suspended' });
  });

  it('the vendor cannot undo it; restoring puts the product back to draft, not live', async () => {
    const { vendor, product } = await liveProduct();
    await patch(`/admin/products/${product.id}/status`, { status: 'suspended' });
    const own = await api(app, 'patch', `/vendor/products/${product.id}`, vendor.auth, {
      status: 'active',
    });
    expect(own.status).toBe(409);

    const res = await patch(`/admin/products/${product.id}/status`, { status: 'draft' });
    expect(res.body.data).toMatchObject({ status: 'draft', previousStatus: 'suspended' });
    expect((await request(app).get(`/api/v1/products/${product.slug}`)).status).toBe(404);
    // Back in the vendor's hands: they can publish it again.
    const again = await api(app, 'patch', `/vendor/products/${product.id}`, vendor.auth, {
      status: 'active',
    });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
  });

  it('refuses a move the table does not allow (409), an unknown product (404) and a bad body (422)', async () => {
    const { product } = await liveProduct();
    // restore of something that is not suspended
    expect((await patch(`/admin/products/${product.id}/status`, { status: 'draft' })).status).toBe(
      409,
    );
    await patch(`/admin/products/${product.id}/status`, { status: 'suspended' });
    // suspend twice
    const twice = await patch(`/admin/products/${product.id}/status`, { status: 'suspended' });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(
      (await patch(`/admin/products/${'0'.repeat(24)}/status`, { status: 'suspended' })).status,
    ).toBe(404);
    for (const body of [
      { status: 'active' },
      { status: 'archived' },
      {},
      { status: 'suspended', x: 1 },
    ]) {
      expect((await patch(`/admin/products/${product.id}/status`, body)).status).toBe(422);
    }
    expect(await AuditLog.countDocuments({ action: 'product.status_changed' })).toBe(1);
  });

  it('five admins suspending at once change it once and write one audit entry', async () => {
    const { product } = await liveProduct();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        patch(`/admin/products/${product.id}/status`, { status: 'suspended' }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await AuditLog.countDocuments({ action: 'product.status_changed' })).toBe(1);
    expect((await Product.findById(product.id)).status).toBe('suspended');
  });
});

describe('GET /admin/reviews', () => {
  it('lists published and hidden reviews with product and customer, filtered and paged', async () => {
    const category = await makeCategory();
    const vendor = await makeVendor(app, 'v@example.com', { approved: true });
    const p1 = await addProduct(app, vendor, category, { title: 'Reviewed One', sku: 'R-1' });
    const p2 = await addProduct(app, vendor, category, { title: 'Reviewed Two', sku: 'R-2' });
    const c1 = await makeCustomerDirect('c1@example.com');
    const c2 = await makeCustomerDirect('c2@example.com');
    const base = {
      vendorId: vendor.shop.id,
      subOrderId: vendor.shop.id,
      body: 'A fine long review text.',
    };
    const r1 = await Review.create({ ...base, productId: p1.id, customerId: c1.id, rating: 5 });
    const r2 = await Review.create({
      ...base,
      productId: p1.id,
      customerId: c2.id,
      rating: 2,
      status: 'hidden',
    });
    const r3 = await Review.create({ ...base, productId: p2.id, customerId: c1.id, rating: 5 });

    const all = await get('/admin/reviews');
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.meta.total).toBe(3);
    expect(all.body.data.map((r) => r.id)).toEqual([r3.id, r2.id, r1.id]);
    expect(all.body.data[1]).toMatchObject({
      status: 'hidden',
      rating: 2,
      product: { id: p1.id, title: 'Reviewed One' },
      customer: { email: 'c2@example.com' },
    });

    const ids = async (qs) => (await get(`/admin/reviews?${qs}`)).body.data.map((r) => r.id);
    expect(await ids('status=hidden')).toEqual([r2.id]);
    expect(await ids(`productId=${p2.id}`)).toEqual([r3.id]);
    expect((await ids('rating=5')).sort()).toEqual([r1.id, r3.id].sort());
    expect((await get('/admin/reviews?rating=6')).status).toBe(422);
  });
});

describe('GET /admin/orders and /admin/orders/:id', () => {
  it('lists orders newest first, filters them and finds one by the start of its number', async () => {
    const o1 = await paidOrder(app, ledger);
    const res = await get('/admin/orders');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.meta.total).toBe(1);
    expect(res.body.data[0]).toMatchObject({
      id: o1.orderId,
      status: 'placed',
      paymentStatus: 'paid',
      refundStatus: 'none',
      customer: { email: 'cust@example.com' },
    });
    const number = res.body.data[0].orderNumber;
    const count = async (qs) => (await get(`/admin/orders?${qs}`)).body.data.length;
    expect(await count(`q=${number.slice(0, 12).toLowerCase()}`)).toBe(1); // prefix, any case
    expect(await count('q=XX-')).toBe(0);
    expect(await count('q=.*')).toBe(0); // literal, not a pattern
    expect(await count('paymentStatus=unpaid')).toBe(0);
    expect(await count('status=placed&paymentStatus=paid')).toBe(1);
    expect((await get('/admin/orders?status=bogus')).status).toBe(422);
  });

  it('the detail shows sub-orders with money, refundable amount, refunds and the settlement', async () => {
    const o = await paidOrder(app, ledger, {
      vendorCount: 2,
      prices: [100000, 50000],
      quantities: [2, 1],
    });
    const refund = await api(app, 'post', `/admin/sub-orders/${o.subs[0].id}/refund`, admin.auth, {
      reason: 'admin',
      note: 'Damaged item',
      amountPaise: 50000,
    });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);

    const res = await get(`/admin/orders/${o.orderId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const order = res.body.data;
    expect(order).toMatchObject({
      id: o.orderId,
      refundStatus: 'partial',
      totalPaise: 250000,
      customer: { email: 'cust@example.com' },
      shippingAddress: { city: 'Kochi' },
      payment: { provider: 'mock', status: 'captured', amountPaise: 250000 },
    });
    expect(order.subOrders).toHaveLength(2);
    const first = order.subOrders.find((s) => s.id === o.subs[0].id);
    expect(first).toMatchObject({
      customerTotalPaise: 200000,
      commission: { rateBps: 1000, amountPaise: 20000 },
      vendorPayoutPaise: 180000,
      fulfillmentStatus: 'processing',
      refundStatus: 'partial',
      refundedPaise: 50000,
      refundablePaise: 150000,
      settlement: { status: 'not_eligible', commissionPaise: 20000 },
    });
    expect(first.refunds).toEqual([
      expect.objectContaining({
        status: 'processed',
        reason: 'admin',
        amountPaise: 50000,
        note: 'Damaged item',
      }),
    ]);
    expect(first.shop.name).toBe('Shop Number 0');
    const second = order.subOrders.find((s) => s.id === o.subs[1].id);
    expect(second.refundablePaise).toBe(50000);
    expect(second.refunds).toEqual([]);
  });

  it('refundablePaise is 0 once the return window has closed or the sub-order is cancelled', async () => {
    const o = await paidOrder(app, ledger, { vendorCount: 2 });
    await deliver(app, o.vendors[0], o.subs[0].id);
    const sub = o.subs[1];
    await api(app, 'patch', `/vendor/sub-orders/${sub.id}/status`, o.vendors[1].auth, {
      status: 'cancelled',
    });

    const inWindow = (await get(`/admin/orders/${o.orderId}`)).body.data.subOrders;
    expect(inWindow.find((s) => s.id === o.subs[0].id).refundablePaise).toBe(20000);
    expect(inWindow.find((s) => s.id === sub.id)).toMatchObject({
      fulfillmentStatus: 'cancelled',
      refundablePaise: 0,
    });

    const { SubOrder } = await import('../src/modules/orders/orders.model.js');
    await SubOrder.updateOne(
      { _id: o.subs[0].id },
      { returnWindowEndsAt: new Date(Date.now() - 1000) },
    );
    const closed = (await get(`/admin/orders/${o.orderId}`)).body.data.subOrders;
    expect(closed.find((s) => s.id === o.subs[0].id).refundablePaise).toBe(0);
  });

  it('404 for an unknown order and 422 for a malformed id', async () => {
    expect((await get(`/admin/orders/${'0'.repeat(24)}`)).status).toBe(404);
    expect((await get('/admin/orders/not-an-id')).status).toBe(422);
  });
});
