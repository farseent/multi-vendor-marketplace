import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Cart } from '../src/modules/cart/cart.model.js';
import { Product } from '../src/modules/catalog/products.model.js';
import { Coupon } from '../src/modules/coupons/coupons.model.js';
import { CouponRedemption } from '../src/modules/coupons/redemptions.model.js';
import { Vendor } from '../src/modules/shops/shops.model.js';
import { clearDb, startTestDb, stopTestDb } from './db.js';
import { makeAdmin, makeCategory, makeVendor, productBody, signUp } from './factories.js';
import { buildTestApp } from './helpers.js';

let replSet;
let app;
beforeAll(async () => {
  replSet = await startTestDb();
}, 60_000);
afterAll(() => stopTestDb(replSet));
beforeEach(async () => {
  await clearDb();
  app = buildTestApp();
});

const api = (method, path, auth, body) => {
  const req = request(app)
    [method](`/api/v1${path}`)
    .set(auth ?? {});
  return body === undefined ? req : req.send(body);
};

/** Two approved vendors (A, B), one category and a signed-up customer. */
async function setup() {
  const [vendorA, vendorB] = [
    await makeVendor(app, 'a@example.com', { approved: true, shopName: 'Shop Alpha' }),
    await makeVendor(app, 'b@example.com', { approved: true, shopName: 'Shop Beta' }),
  ];
  const category = await makeCategory();
  const customer = await signUp(app, 'cust@example.com');
  return { vendorA, vendorB, category, customer };
}

let skuCounter = 0;
async function addProduct(vendor, category, overrides = {}) {
  const res = await api(
    'post',
    '/vendor/products',
    vendor.auth,
    productBody(vendor.shop.id, category.id, {
      sku: `SKU-${++skuCounter}`,
      status: 'active',
      pricePaise: 10000,
      stockQty: 20,
      ...overrides,
    }),
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

const now = Date.now();
const makeCoupon = (overrides = {}) =>
  Coupon.create({
    code: 'SAVE10',
    scope: 'platform',
    fundedBy: 'platform',
    type: 'percent',
    value: 10,
    startsAt: new Date(now - 86_400_000),
    expiresAt: new Date(now + 86_400_000),
    ...overrides,
  });

describe('access', () => {
  it('needs a customer token on every cart route', async () => {
    const { vendorA } = await setup();
    const admin = await makeAdmin(app);
    const id = '0'.repeat(24);
    const calls = [
      ['get', '/cart'],
      ['delete', '/cart'],
      ['put', `/cart/items/${id}`, { quantity: 1 }],
      ['delete', `/cart/items/${id}`],
      ['post', '/cart/coupon', { code: 'SAVE10' }],
      ['delete', '/cart/coupon'],
    ];
    for (const [method, path, body] of calls) {
      expect((await api(method, path, undefined, body)).status, `${method} ${path}`).toBe(401);
      expect((await api(method, path, vendorA.auth, body)).status, `${method} ${path}`).toBe(403);
      expect((await api(method, path, admin.auth, body)).status, `${method} ${path}`).toBe(403);
    }
  });
});

describe('cart basics and priced preview', () => {
  it('starts empty', async () => {
    const { customer } = await setup();
    const res = await api('get', '/cart', customer.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      items: [],
      itemCount: 0,
      subtotalPaise: 0,
      discountPaise: 0,
      shippingPaise: 0,
      totalPaise: 0,
      currency: 'INR',
      coupon: null,
      couponError: null,
      hasIssues: false,
    });
  });

  it('adds, re-prices, changes quantity and removes lines', async () => {
    const { vendorA, vendorB, category, customer } = await setup();
    const kurta = await addProduct(vendorA, category, { title: 'Kurta', pricePaise: 149900 });
    const scarf = await addProduct(vendorB, category, { title: 'Scarf', pricePaise: 25050 });

    const first = await api('put', `/cart/items/${kurta.id}`, customer.auth, { quantity: 2 });
    expect(first.status).toBe(200);
    expect(first.body.data.items).toHaveLength(1);
    expect(first.body.data.items[0]).toMatchObject({
      productId: kurta.id,
      slug: kurta.slug,
      title: 'Kurta',
      quantity: 2,
      status: 'ok',
      unitPricePaise: 149900,
      lineSubtotalPaise: 299800,
      shop: { name: 'Shop Alpha' },
    });
    expect(first.body.data.items[0].imageUrl).toContain('https://cdn.test/products/');

    await api('put', `/cart/items/${scarf.id}`, customer.auth, { quantity: 1 });
    const changed = await api('put', `/cart/items/${kurta.id}`, customer.auth, { quantity: 3 });
    expect(changed.body.data).toMatchObject({
      itemCount: 4,
      subtotalPaise: 3 * 149900 + 25050,
      totalPaise: 3 * 149900 + 25050,
    });
    expect(changed.body.data.items).toHaveLength(2);

    const removed = await api('put', `/cart/items/${kurta.id}`, customer.auth, { quantity: 0 });
    expect(removed.body.data.items.map((i) => i.title)).toEqual(['Scarf']);

    // DELETE is idempotent
    expect((await api('delete', `/cart/items/${kurta.id}`, customer.auth)).status).toBe(200);
    const cleared = await api('delete', '/cart', customer.auth);
    expect(cleared.body.data.items).toEqual([]);
    expect(await Cart.countDocuments()).toBe(0);
  });

  it('never exposes a vendorId field or exact stock', async () => {
    const { vendorA, category, customer } = await setup();
    const p = await addProduct(vendorA, category, { stockQty: 7 });
    const res = await api('put', `/cart/items/${p.id}`, customer.auth, { quantity: 1 });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('stockQty');
    expect(text).not.toContain('vendorId');
    // (the vendor id still appears inside public image URLs by design, D32)
  });

  it('keeps each customer cart separate', async () => {
    const { vendorA, category, customer } = await setup();
    const other = await signUp(app, 'other@example.com');
    const p = await addProduct(vendorA, category);
    await api('put', `/cart/items/${p.id}`, customer.auth, { quantity: 2 });
    expect((await api('get', '/cart', other.auth)).body.data.items).toEqual([]);
    expect((await api('get', '/cart', customer.auth)).body.data.itemCount).toBe(2);
  });

  it('prices from current data: a new price shows up on the next read', async () => {
    const { vendorA, category, customer } = await setup();
    const p = await addProduct(vendorA, category, { pricePaise: 10000 });
    await api('put', `/cart/items/${p.id}`, customer.auth, { quantity: 2 });
    await api('patch', `/vendor/products/${p.id}`, vendorA.auth, { pricePaise: 12500 });
    const res = await api('get', '/cart', customer.auth);
    expect(res.body.data.items[0].unitPricePaise).toBe(12500);
    expect(res.body.data.subtotalPaise).toBe(25000);
  });
});

describe('validation and purchasability', () => {
  it('rejects quantity above 10 (422) and other malformed input', async () => {
    const { vendorA, category, customer } = await setup();
    const p = await addProduct(vendorA, category);
    for (const body of [
      { quantity: 11 },
      { quantity: -1 },
      { quantity: 1.5 },
      { quantity: '2' },
      { quantity: 1, extra: true },
      {},
    ]) {
      const res = await api('put', `/cart/items/${p.id}`, customer.auth, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await api('put', '/cart/items/not-an-id', customer.auth, { quantity: 1 })).status).toBe(
      422,
    );
    expect(await Cart.countDocuments()).toBe(0);
  });

  it('accepts exactly 10', async () => {
    const { vendorA, category, customer } = await setup();
    const p = await addProduct(vendorA, category, { stockQty: 50 });
    const res = await api('put', `/cart/items/${p.id}`, customer.auth, { quantity: 10 });
    expect(res.status).toBe(200);
    expect(res.body.data.itemCount).toBe(10);
  });

  it('answers 409 for a product that is not purchasable (any reason, no probing)', async () => {
    const { vendorA, vendorB, category, customer } = await setup();
    const draft = await addProduct(vendorA, category, { status: 'draft' });
    const archived = await addProduct(vendorA, category);
    await api('delete', `/vendor/products/${archived.id}`, vendorA.auth);
    const suspended = await addProduct(vendorA, category);
    await Product.updateOne({ _id: suspended.id }, { status: 'suspended' });
    const ofSuspendedShop = await addProduct(vendorB, category);
    await Vendor.updateOne({ _id: vendorB.shop.id }, { status: 'suspended' });

    for (const id of [draft.id, archived.id, suspended.id, ofSuspendedShop.id, 'f'.repeat(24)]) {
      const res = await api('put', `/cart/items/${id}`, customer.auth, { quantity: 1 });
      expect(res.status, id).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    }
    expect(await Cart.countDocuments()).toBe(0);
  });

  it('answers 409 OUT_OF_STOCK when the quantity is more than the stock', async () => {
    const { vendorA, category, customer } = await setup();
    const p = await addProduct(vendorA, category, { stockQty: 2 });
    const res = await api('put', `/cart/items/${p.id}`, customer.auth, { quantity: 3 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'OUT_OF_STOCK',
      details: [{ productId: p.id, available: 2 }],
    });
    await api('patch', `/vendor/products/${p.id}/stock`, vendorA.auth, { stockQty: 0 });
    const none = await api('put', `/cart/items/${p.id}`, customer.auth, { quantity: 1 });
    expect(none.body.error.details).toEqual([{ productId: p.id, available: 0 }]);
  });

  it('allows the 30th product but not the 31st; existing lines can still change', async () => {
    const { vendorA, category, customer } = await setup();
    const docs = Array.from({ length: 31 }, (_, i) => ({
      vendorId: vendorA.shop.id,
      title: `Bulk product ${i}`,
      slug: `bulk-product-${i}`,
      categoryId: category.id,
      pricePaise: 10000,
      sku: `BULK-${i}`,
      stockQty: 10,
      images: [{ key: `products/${vendorA.shop.id}/x.webp` }],
      status: 'active',
    }));
    const products = await Product.insertMany(docs);

    for (const p of products.slice(0, 30)) {
      const res = await api('put', `/cart/items/${p.id}`, customer.auth, { quantity: 1 });
      expect(res.status).toBe(200);
    }
    const full = await api('put', `/cart/items/${products[30].id}`, customer.auth, { quantity: 1 });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('CONFLICT');

    const edit = await api('put', `/cart/items/${products[0].id}`, customer.auth, { quantity: 4 });
    expect(edit.status).toBe(200);
    expect(edit.body.data.items).toHaveLength(30);
    expect(edit.body.data.items[0].quantity).toBe(4);
  });

  it('survives parallel requests: no lost lines, no duplicate lines', async () => {
    const { vendorA, category, customer } = await setup();
    const products = [];
    for (let i = 0; i < 6; i++) products.push(await addProduct(vendorA, category));

    // New cart, six different products at once (they race to create the cart document).
    const results = await Promise.all(
      products.map((p) => api('put', `/cart/items/${p.id}`, customer.auth, { quantity: 1 })),
    );
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect((await api('get', '/cart', customer.auth)).body.data.items).toHaveLength(6);

    // Same product, many times at once: still one line.
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        api('put', `/cart/items/${products[0].id}`, customer.auth, { quantity: (i % 5) + 1 }),
      ),
    );
    const cart = await Cart.findOne({});
    expect(cart.items).toHaveLength(6);
  });
});

describe('stock and availability warnings', () => {
  it('flags insufficient stock and unavailable lines, and excludes unavailable ones from totals', async () => {
    const { vendorA, vendorB, category, customer } = await setup();
    const low = await addProduct(vendorA, category, { pricePaise: 10000, stockQty: 10 });
    const gone = await addProduct(vendorA, category, { pricePaise: 5000 });
    const fine = await addProduct(vendorB, category, { pricePaise: 2000 });
    for (const [p, quantity] of [
      [low, 4],
      [gone, 1],
      [fine, 1],
    ]) {
      await api('put', `/cart/items/${p.id}`, customer.auth, { quantity });
    }

    await api('patch', `/vendor/products/${low.id}/stock`, vendorA.auth, { stockQty: 1 });
    await api('delete', `/vendor/products/${gone.id}`, vendorA.auth); // archive

    const res = await api('get', '/cart', customer.auth);
    const byId = Object.fromEntries(res.body.data.items.map((i) => [i.productId, i]));
    expect(byId[low.id]).toMatchObject({ status: 'insufficient_stock', available: 1 });
    expect(byId[gone.id].status).toBe('unavailable');
    expect(byId[gone.id]).not.toHaveProperty('unitPricePaise'); // not priced
    expect(byId[fine.id].status).toBe('ok');
    expect(res.body.data.hasIssues).toBe(true);
    // 4 * 10000 (insufficient stock is still priced) + 2000; the archived line is not counted
    expect(res.body.data.subtotalPaise).toBe(42000);

    // An unavailable line can still be removed.
    const after = await api('delete', `/cart/items/${gone.id}`, customer.auth);
    expect(after.body.data.items.map((i) => i.productId)).not.toContain(gone.id);
  });
});

describe('coupons on the cart', () => {
  async function cartWithTwoVendors() {
    const ctx = await setup();
    const a = await addProduct(ctx.vendorA, ctx.category, { pricePaise: 30000 }); // x2 = 60000
    const b = await addProduct(ctx.vendorB, ctx.category, { pricePaise: 40000 }); // x1 = 40000
    await api('put', `/cart/items/${a.id}`, ctx.customer.auth, { quantity: 2 });
    await api('put', `/cart/items/${b.id}`, ctx.customer.auth, { quantity: 1 });
    return { ...ctx, a, b };
  }

  it('applies a platform coupon across all lines and shows the allocation', async () => {
    const { customer, a, b } = await cartWithTwoVendors();
    await makeCoupon({ code: 'SAVE10' }); // 10% of 100000 = 10000
    const res = await api('post', '/cart/coupon', customer.auth, { code: ' save10 ' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      subtotalPaise: 100000,
      discountPaise: 10000,
      totalPaise: 90000,
      coupon: { code: 'SAVE10', scope: 'platform', type: 'percent', discountPaise: 10000 },
      couponError: null,
    });
    const line = (id) => res.body.data.items.find((i) => i.productId === id);
    expect(line(a.id)).toMatchObject({ discountPaise: 6000, lineNetPaise: 54000 });
    expect(line(b.id)).toMatchObject({ discountPaise: 4000, lineNetPaise: 36000 });
    // and it is remembered
    expect((await api('get', '/cart', customer.auth)).body.data.coupon.code).toBe('SAVE10');
  });

  it("applies a vendor coupon only to that vendor's items", async () => {
    const { customer, vendorA, a, b } = await cartWithTwoVendors();
    await makeCoupon({
      code: 'ALPHA20',
      scope: 'vendor',
      fundedBy: 'vendor',
      vendorId: vendorA.shop.id,
      value: 20,
    });
    const res = await api('post', '/cart/coupon', customer.auth, { code: 'ALPHA20' });
    expect(res.status).toBe(200);
    const line = (id) => res.body.data.items.find((i) => i.productId === id);
    expect(res.body.data.discountPaise).toBe(12000); // 20% of Alpha's 60000
    expect(line(a.id).discountPaise).toBe(12000);
    expect(line(b.id).discountPaise).toBe(0);
    expect(res.body.data.totalPaise).toBe(88000);
  });

  it('line discounts always add up to the coupon discount, even with odd amounts', async () => {
    const { vendorA, vendorB, category, customer } = await setup();
    const prices = [333, 777, 1999];
    for (const [i, pricePaise] of prices.entries()) {
      const p = await addProduct(i % 2 ? vendorB : vendorA, category, { pricePaise });
      await api('put', `/cart/items/${p.id}`, customer.auth, { quantity: 3 });
    }
    await makeCoupon({ code: 'ODD7', type: 'fixed', value: 1001 });
    const res = await api('post', '/cart/coupon', customer.auth, { code: 'ODD7' });
    const sum = res.body.data.items.reduce((s, i) => s + i.discountPaise, 0);
    expect(res.body.data.discountPaise).toBe(1001);
    expect(sum).toBe(1001);
    expect(res.body.data.totalPaise).toBe(res.body.data.subtotalPaise - 1001);
  });

  it.each([
    ['unknown code', { code: 'NOPE1234' }, {}, 'not_found'],
    ['disabled', { code: 'OFF1' }, { status: 'disabled' }, 'disabled'],
    ['expired', { code: 'OLD1' }, { expiresAt: new Date(now - 1000) }, 'expired'],
    [
      'not started',
      { code: 'SOON1' },
      { startsAt: new Date(now + 3_600_000), expiresAt: new Date(now + 7_200_000) },
      'not_started',
    ],
    ['below the minimum', { code: 'BIG1' }, { minOrderPaise: 100001 }, 'below_min_order'],
    [
      'total limit used up',
      { code: 'FULL1' },
      { usageLimitTotal: 3, usedCount: 3 },
      'total_limit_reached',
    ],
  ])(
    'refuses a coupon that is %s with 422 COUPON_INVALID',
    async (_name, { code }, fields, reason) => {
      const { customer } = await cartWithTwoVendors();
      if (reason !== 'not_found') await makeCoupon({ code, ...fields });
      const res = await api('post', '/cart/coupon', customer.auth, { code });
      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'COUPON_INVALID', details: { reason } });
      expect((await api('get', '/cart', customer.auth)).body.data.coupon).toBeNull(); // nothing saved
    },
  );

  it('refuses a vendor coupon when the cart has nothing from that vendor', async () => {
    const { vendorA, category, customer } = await setup();
    const other = await makeVendor(app, 'c@example.com', {
      approved: true,
      shopName: 'Shop Gamma',
    });
    const p = await addProduct(vendorA, category);
    await api('put', `/cart/items/${p.id}`, customer.auth, { quantity: 1 });
    await makeCoupon({
      code: 'GAMMA',
      scope: 'vendor',
      fundedBy: 'vendor',
      vendorId: other.shop.id,
    });
    const res = await api('post', '/cart/coupon', customer.auth, { code: 'GAMMA' });
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual({ reason: 'wrong_vendor' });
  });

  it("enforces the per-user limit using that customer's reserved/redeemed uses only", async () => {
    const { customer } = await cartWithTwoVendors();
    const coupon = await makeCoupon({ code: 'ONCE1', usageLimitPerUser: 1 });
    const someone = await signUp(app, 'someone@example.com');
    const orderId = '1'.repeat(24);
    // another customer's use does not count
    await CouponRedemption.create({
      couponId: coupon._id,
      customerId: someone.id,
      orderId,
      discountPaise: 100,
      status: 'redeemed',
    });
    expect((await api('post', '/cart/coupon', customer.auth, { code: 'ONCE1' })).status).toBe(200);

    // a released reservation does not count either; a reserved one does
    await CouponRedemption.create({
      couponId: coupon._id,
      customerId: customer.id,
      orderId: '2'.repeat(24),
      discountPaise: 100,
      status: 'released',
    });
    expect((await api('post', '/cart/coupon', customer.auth, { code: 'ONCE1' })).status).toBe(200);
    await CouponRedemption.create({
      couponId: coupon._id,
      customerId: customer.id,
      orderId: '3'.repeat(24),
      discountPaise: 100,
      status: 'reserved',
    });
    const res = await api('post', '/cart/coupon', customer.auth, { code: 'ONCE1' });
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual({ reason: 'user_limit_reached' });
  });

  it('clamps a fixed coupon larger than the subtotal', async () => {
    const { customer } = await cartWithTwoVendors();
    await makeCoupon({ code: 'HUGE', type: 'fixed', value: 999999 });
    const res = await api('post', '/cart/coupon', customer.auth, { code: 'HUGE' });
    expect(res.body.data).toMatchObject({ discountPaise: 100000, totalPaise: 0 });
  });

  it('refuses a coupon on an empty cart', async () => {
    const { customer } = await setup();
    await makeCoupon({ code: 'SAVE10' });
    const res = await api('post', '/cart/coupon', customer.auth, { code: 'SAVE10' });
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual({ reason: 'empty_cart' });
  });

  it('replaces a coupon, keeps the old one when the new one is refused, and removes it', async () => {
    const { customer } = await cartWithTwoVendors();
    await makeCoupon({ code: 'SAVE10' });
    await makeCoupon({ code: 'FLAT500', type: 'fixed', value: 500 });
    await api('post', '/cart/coupon', customer.auth, { code: 'SAVE10' });

    const refused = await api('post', '/cart/coupon', customer.auth, { code: 'MISSING1' });
    expect(refused.status).toBe(422);
    expect((await api('get', '/cart', customer.auth)).body.data.coupon.code).toBe('SAVE10');

    const replaced = await api('post', '/cart/coupon', customer.auth, { code: 'FLAT500' });
    expect(replaced.body.data.discountPaise).toBe(500);

    const removed = await api('delete', '/cart/coupon', customer.auth);
    expect(removed.status).toBe(200);
    expect(removed.body.data).toMatchObject({ coupon: null, discountPaise: 0, totalPaise: 100000 });
    expect((await api('delete', '/cart/coupon', customer.auth)).status).toBe(200); // idempotent
  });

  it('shows couponError (and no discount) when a saved coupon stops being valid', async () => {
    const { customer } = await cartWithTwoVendors();
    const coupon = await makeCoupon({ code: 'SAVE10' });
    await api('post', '/cart/coupon', customer.auth, { code: 'SAVE10' });
    await Coupon.updateOne({ _id: coupon._id }, { status: 'disabled' });

    const res = await api('get', '/cart', customer.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      coupon: null,
      couponError: { code: 'SAVE10', reason: 'disabled' },
      discountPaise: 0,
      totalPaise: 100000,
    });
  });

  it('re-evaluates the saved coupon when the cart changes (minimum order)', async () => {
    const { customer, a } = await cartWithTwoVendors();
    await makeCoupon({ code: 'MIN90', minOrderPaise: 90000 });
    await api('post', '/cart/coupon', customer.auth, { code: 'MIN90' });
    const res = await api('put', `/cart/items/${a.id}`, customer.auth, { quantity: 1 }); // 70000 now
    expect(res.body.data.coupon).toBeNull();
    expect(res.body.data.couponError).toEqual({ code: 'MIN90', reason: 'below_min_order' });
  });

  it('rejects malformed coupon bodies', async () => {
    const { customer } = await cartWithTwoVendors();
    for (const body of [
      {},
      { code: '' },
      { code: 5 },
      { code: { $ne: '' } },
      { code: 'X', extra: 1 },
    ]) {
      const res = await api('post', '/cart/coupon', customer.auth, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});
