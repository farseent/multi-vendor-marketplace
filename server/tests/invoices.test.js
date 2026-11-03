import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Invoice } from '../src/modules/invoices/invoices.model.js';
import { createInvoicesService } from '../src/modules/invoices/invoices.service.js';
import { Counter, Order } from '../src/modules/orders/orders.model.js';
import { createMockLedger } from '../src/providers/payment/mockLedger.js';
import { clearDb, startTestDb, stopTestDb } from './db.js';
import { makeAdmin } from './factories.js';
import { buildTestApp } from './helpers.js';
import {
  addProduct,
  checkout,
  fillCart,
  makeCustomerDirect,
  setupMarket,
} from './phase5.helpers.js';
import { paidOrder } from './phase6.helpers.js';

let replSet;
let app;
let ledger;
beforeAll(async () => {
  replSet = await startTestDb();
}, 60_000);
afterAll(() => stopTestDb(replSet));
beforeEach(async () => {
  await clearDb();
  ledger = createMockLedger();
  app = buildTestApp({ paymentProvider: ledger });
});

/** GET the invoice and keep the body as raw bytes (supertest would otherwise try to parse it). */
const download = (orderId, auth) => {
  const req = request(app)
    .get(`/api/v1/orders/${orderId}/invoice`)
    .set(auth ?? {})
    .buffer(true)
    .parse((res, done) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
  return req;
};

/** An invoice service whose "PDF" is the view it was asked to draw: tests read the numbers on it. */
function capturingService() {
  const views = [];
  const service = createInvoicesService({
    render: async (view) => {
      views.push(view);
      return Buffer.from('%PDF-1.3 test');
    },
  });
  return { service, views };
}

describe('GET /orders/:orderId/invoice: access', () => {
  it('the owner gets a PDF of a paid order, named after the invoice number', async () => {
    const o = await paidOrder(app, ledger, { vendorCount: 2 });
    const res = await download(o.orderId, o.customer.auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="INV-\d{4}-000001\.pdf"$/,
    );
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(res.body.subarray(-8).toString('latin1')).toContain('%%EOF');
    expect(res.body.length).toBeGreaterThan(1000);
  });

  it('downloading again returns the SAME invoice number and creates no second record', async () => {
    const o = await paidOrder(app, ledger);
    const first = await download(o.orderId, o.customer.auth);
    const second = await download(o.orderId, o.customer.auth);
    expect(second.headers['content-disposition']).toBe(first.headers['content-disposition']);
    expect(await Invoice.countDocuments()).toBe(1);
  });

  it("another customer's order is 404 and no invoice number is spent", async () => {
    const o = await paidOrder(app, ledger);
    const stranger = await makeCustomerDirect('stranger@example.com');
    const res = await download(o.orderId, stranger.auth);
    expect(res.status).toBe(404);
    expect(await Invoice.countDocuments()).toBe(0);
    expect(await Counter.countDocuments({ _id: /^invoice:/ })).toBe(0);
  });

  it('an unpaid order is 409 order_not_paid and has no invoice', async () => {
    const { vendors, category, customer } = await setupMarket(app, { vendors: 1 });
    const product = await addProduct(app, vendors[0], category);
    await fillCart(app, customer, [{ productId: product.id, quantity: 1 }]);
    const placed = await checkout(app, customer);
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);

    const res = await request(app)
      .get(`/api/v1/orders/${placed.body.data.order.id}/invoice`)
      .set(customer.auth);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'order_not_paid' },
    });
    expect(await Invoice.countDocuments()).toBe(0);
  });

  it('anonymous 401; vendor and admin 403; malformed id 422; unknown id 404', async () => {
    const o = await paidOrder(app, ledger);
    const admin = await makeAdmin(app);
    expect((await download(o.orderId)).status).toBe(401);
    expect((await download(o.orderId, o.vendors[0].auth)).status).toBe(403);
    expect((await download(o.orderId, admin.auth)).status).toBe(403);
    expect((await download('not-an-id', o.customer.auth)).status).toBe(422);
    expect((await download('0'.repeat(24), o.customer.auth)).status).toBe(404);
  });
});

describe('what the invoice lists', () => {
  it('every vendor, every item, the discount, shipping and the total (all in paise)', async () => {
    const coupon = { code: 'SAVE10' };
    const o = await paidOrder(app, ledger, {
      vendorCount: 2,
      prices: [30000, 45000],
      quantities: [2, 1],
      coupon,
    });
    const { service, views } = capturingService();
    await service.generate(o.customer.id, o.orderId);
    const view = views[0];
    const order = await Order.findById(o.orderId);

    expect(view.invoiceNumber).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(view.orderNumber).toBe(order.orderNumber);
    expect(view.sections).toHaveLength(2); // both vendors
    const titles = view.sections.flatMap((s) => s.items.map((i) => i.title));
    expect(titles).toEqual(expect.arrayContaining(o.products.map((p) => p.title)));
    expect(view.sections.map((s) => s.shopName).sort()).toEqual(['Shop Number 0', 'Shop Number 1']);

    expect(view.coupon.code).toBe('SAVE10');
    expect(view.totals.discountPaise).toBe(order.discountPaise);
    expect(view.totals.discountPaise).toBeGreaterThan(0);
    expect(view.totals.totalPaise).toBe(order.totalPaise);
    expect(view.totals.totalPaise).toBe(
      view.totals.subtotalPaise - view.totals.discountPaise + view.totals.shippingPaise,
    );
    // The seller blocks add up to the order total, and every line's net adds up to its seller total.
    expect(view.sections.reduce((sum, s) => sum + s.customerTotalPaise, 0)).toBe(order.totalPaise);
    for (const section of view.sections) {
      const lines = section.items.reduce((sum, i) => sum + i.lineNetPaise, 0);
      expect(lines + section.shippingPaise).toBe(section.customerTotalPaise);
    }
    expect(view.totals.refundedPaise).toBe(0);
    expect(view.totals.netPaidPaise).toBe(order.totalPaise);
  });

  it('shows what was refunded afterwards, while the invoice number stays the same', async () => {
    const o = await paidOrder(app, ledger, { prices: [100000], quantities: [2] });
    const admin = await makeAdmin(app);
    const { service, views } = capturingService();
    await service.generate(o.customer.id, o.orderId);

    const refund = await request(app)
      .post(`/api/v1/admin/sub-orders/${o.subs[0].id}/refund`)
      .set(admin.auth)
      .send({ reason: 'admin', note: 'Damaged item', amountPaise: 50000 });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);

    await service.generate(o.customer.id, o.orderId);
    expect(views[1].invoiceNumber).toBe(views[0].invoiceNumber);
    expect(views[1].totals.refundedPaise).toBe(50000);
    expect(views[1].totals.netPaidPaise).toBe(views[1].totals.totalPaise - 50000);
  });
});

describe('invoice numbers under concurrency', () => {
  /** A paid order with no sub-orders: enough for the numbering code, which only needs `_id`. */
  const bareOrder = (customerId, n) =>
    Order.create({
      orderNumber: `MP-20260101-9${String(n).padStart(5, '0')}`,
      customerId,
      status: 'placed',
      paymentStatus: 'paid',
      shippingAddress: { name: 'Asha K', line1: '1 Road', city: 'Kochi', state: 'Kerala' },
      subtotalPaise: 10000,
      discountPaise: 0,
      shippingPaise: 0,
      totalPaise: 10000,
      idempotencyKey: `bare-${n}`,
    });

  it('20 different orders at once get 20 unique, well-formed numbers', async () => {
    const customer = await makeCustomerDirect('bulk@example.com');
    const orders = await Promise.all(
      Array.from({ length: 20 }, (_, i) => bareOrder(customer.id, i)),
    );
    const { invoicesService } = app.get('phase7Services');

    const invoices = await Promise.all(orders.map((order) => invoicesService.ensureInvoice(order)));
    const numbers = invoices.map((i) => i.invoiceNumber);
    expect(new Set(numbers).size).toBe(20);
    for (const n of numbers) expect(n).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(await Invoice.countDocuments()).toBe(20);
  }, 30_000);

  it('20 requests for ONE order create one invoice; every caller sees the same number', async () => {
    const customer = await makeCustomerDirect('one@example.com');
    const order = await bareOrder(customer.id, 1);
    const { invoicesService } = app.get('phase7Services');

    const invoices = await Promise.all(
      Array.from({ length: 20 }, () => invoicesService.ensureInvoice(order)),
    );
    expect(new Set(invoices.map((i) => i.invoiceNumber)).size).toBe(1);
    expect(await Invoice.countDocuments()).toBe(1);
    // Numbers taken by requests that lost the race are simply skipped: gaps are allowed (D63).
    const counter = await Counter.findOne({ _id: /^invoice:/ });
    expect(counter.seq).toBeGreaterThanOrEqual(1);
    expect(counter.seq).toBeLessThanOrEqual(20);
  }, 30_000);

  it('20 simultaneous downloads of one paid order all succeed with the same PDF name', async () => {
    const o = await paidOrder(app, ledger);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => download(o.orderId, o.customer.auth)),
    );
    for (const res of results) expect(res.status).toBe(200);
    expect(new Set(results.map((r) => r.headers['content-disposition'])).size).toBe(1);
    expect(await Invoice.countDocuments()).toBe(1);
  }, 60_000);

  it('the year in the number follows the generation date and the sequence restarts each year', async () => {
    const customer = await makeCustomerDirect('year@example.com');
    const order = await bareOrder(customer.id, 2);
    await Counter.create({ _id: 'invoice:1999', seq: 41 }); // an old year does not affect this one
    const { invoicesService } = app.get('phase7Services');
    const invoice = await invoicesService.ensureInvoice(order);
    const year = new Date().getUTCFullYear();
    expect(invoice.invoiceNumber).toBe(`INV-${year}-000001`);
  });
});
