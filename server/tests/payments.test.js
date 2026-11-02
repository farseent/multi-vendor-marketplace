import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCache } from '../src/lib/cache.js';
import { Product } from '../src/modules/catalog/products.model.js';
import { Coupon } from '../src/modules/coupons/coupons.model.js';
import { CouponRedemption } from '../src/modules/coupons/redemptions.model.js';
import { createOrderLifecycle } from '../src/modules/orders/orders.lifecycle.js';
import { Order, SubOrder } from '../src/modules/orders/orders.model.js';
import { Payment, WebhookEvent } from '../src/modules/payments/payments.model.js';
import { Refund } from '../src/modules/refunds/refunds.model.js';
import { createSearchOutbox } from '../src/modules/search/search.outbox.js';
import { createMockLedger } from '../src/providers/payment/mockLedger.js';
import { webhookSignature } from '../src/providers/payment/signatures.js';
import { clearDb, startTestDb, stopTestDb } from './db.js';
import { makeAdmin, signUp } from './factories.js';
import { buildTestApp, silentLogger } from './helpers.js';
import { addProduct, api, checkout, fillCart, makeCoupon, setupMarket } from './phase5.helpers.js';

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

/** A pending order for a customer: 2 units of one 10,000-paise product (stock 20 -> 18). */
async function pendingOrder({ coupon = false, stock = 20, quantity = 2 } = {}) {
  const { vendors, category, customer } = await setupMarket(app, { vendors: 1 });
  const product = await addProduct(app, vendors[0], category, { stockQty: stock });
  if (coupon) await makeCoupon({ code: 'SAVE5', value: 5 });
  await fillCart(app, customer, [{ productId: product.id, quantity }]);
  if (coupon) await api(app, 'post', '/cart/coupon', customer.auth, { code: 'SAVE5' });
  const res = await checkout(app, customer);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return {
    customer,
    product,
    orderId: res.body.data.order.id,
    providerOrderId: res.body.data.payment.providerOrderId,
    totalPaise: res.body.data.order.totalPaise,
  };
}

const verifyBody = (o, pay, overrides = {}) => ({
  orderId: o.orderId,
  razorpayOrderId: o.providerOrderId,
  razorpayPaymentId: pay.providerPaymentId,
  razorpaySignature: pay.signature,
  ...overrides,
});
const verify = (o, body, auth = o.customer.auth) =>
  api(app, 'post', '/payments/verify', auth, body);

// A string, not the Buffer: superagent would JSON-encode a Buffer and change the signed bytes.
const sendWebhook = (hook) =>
  request(app)
    .post('/api/v1/webhooks/razorpay')
    .set(hook.headers)
    .send(hook.rawBody.toString('utf8'));
const hookFor = (o, pay, type = 'payment.captured', eventId) =>
  ledger.buildWebhook(type, {
    providerOrderId: o.providerOrderId,
    providerPaymentId: pay.providerPaymentId,
    ...(eventId && { eventId }),
  });

const orderOf = (o) => Order.findById(o.orderId);

describe('POST /payments/verify', () => {
  it('confirms a captured payment: order placed, sub-orders processing, coupon redeemed', async () => {
    const o = await pendingOrder({ coupon: true });
    const pay = ledger.simulatePayment(o.providerOrderId);
    const res = await verify(o, verifyBody(o, pay));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual({
      orderId: o.orderId,
      status: 'placed',
      paymentStatus: 'paid',
      refundStatus: 'none',
    });

    const order = await orderOf(o);
    expect(order.placedAt).toBeInstanceOf(Date);
    expect(String(order.paymentId)).toBe(
      String((await Payment.findOne({ orderId: o.orderId }))._id),
    );
    const subs = await SubOrder.find({ orderId: o.orderId });
    expect(subs.every((s) => s.fulfillmentStatus === 'processing')).toBe(true);
    expect(subs[0].statusHistory.map((h) => h.status)).toEqual(['pending_payment', 'processing']);
    expect(await CouponRedemption.findOne({ orderId: o.orderId })).toMatchObject({
      status: 'redeemed',
    });
    expect(await Payment.findOne({ orderId: o.orderId })).toMatchObject({
      status: 'captured',
      providerPaymentId: pay.providerPaymentId,
      confirmedVia: 'client_verify',
      method: 'upi',
    });
    expect((await Product.findById(o.product.id)).stockQty).toBe(18); // reserved at checkout, untouched now
  });

  it('is idempotent: a second verify returns the same state and changes nothing', async () => {
    const o = await pendingOrder();
    const pay = ledger.simulatePayment(o.providerOrderId);
    const first = await verify(o, verifyBody(o, pay));
    const placedAt = (await orderOf(o)).placedAt;
    const second = await verify(o, verifyBody(o, pay));
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual(first.body.data);
    expect((await orderOf(o)).placedAt).toEqual(placedAt);
    expect((await SubOrder.findOne({ orderId: o.orderId })).statusHistory).toHaveLength(2);
  });

  it('rejects a tampered signature with 400 and leaves the order pending_payment', async () => {
    const o = await pendingOrder();
    const pay = ledger.simulatePayment(o.providerOrderId);
    for (const razorpaySignature of [
      '0'.repeat(64),
      'abc',
      pay.signature.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')),
    ]) {
      const res = await verify(o, verifyBody(o, pay, { razorpaySignature }));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PAYMENT_VERIFICATION_FAILED');
    }
    expect((await orderOf(o)).status).toBe('pending_payment');
    expect((await Payment.findOne({ orderId: o.orderId })).status).toBe('created');
  });

  it('rejects a payment id that the signature was not made for', async () => {
    const o = await pendingOrder();
    const pay = ledger.simulatePayment(o.providerOrderId);
    const other = ledger.simulatePayment(o.providerOrderId);
    const res = await verify(o, verifyBody(o, pay, { razorpayPaymentId: other.providerPaymentId }));
    expect(res.status).toBe(400);
    expect((await orderOf(o)).status).toBe('pending_payment');
  });

  it('rejects a razorpayOrderId that is not the one stored for the order (D48)', async () => {
    const a = await pendingOrder();
    const pay = ledger.simulatePayment(a.providerOrderId);
    const res = await verify(a, verifyBody(a, pay, { razorpayOrderId: 'order_mock_999999' }));
    expect(res.status).toBe(400);
    expect((await orderOf(a)).status).toBe('pending_payment');
  });

  it('rejects a payment whose amount differs from the order (tampered amount)', async () => {
    const o = await pendingOrder();
    const pay = ledger.simulatePayment(o.providerOrderId, { amountPaise: 100 }); // valid signature, wrong amount
    const res = await verify(o, verifyBody(o, pay));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PAYMENT_VERIFICATION_FAILED');
    expect((await orderOf(o)).status).toBe('pending_payment');
    expect((await Payment.findOne({ orderId: o.orderId })).status).toBe('created');
  });

  it('answers 200 with the order unchanged while the payment is only authorized (D48)', async () => {
    const o = await pendingOrder();
    const pay = ledger.simulatePayment(o.providerOrderId, { status: 'authorized' });
    const res = await verify(o, verifyBody(o, pay));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'pending_payment', paymentStatus: 'unpaid' });
    // once the provider captures it, the same call completes the order
    ledger.setPaymentStatus(pay.providerPaymentId, 'captured');
    const again = await verify(o, verifyBody(o, pay));
    expect(again.body.data).toMatchObject({ status: 'placed', paymentStatus: 'paid' });
  });

  it('rejects a failed payment', async () => {
    const o = await pendingOrder();
    const pay = ledger.simulatePayment(o.providerOrderId, { status: 'failed' });
    expect((await verify(o, verifyBody(o, pay))).status).toBe(400);
    expect((await orderOf(o)).status).toBe('pending_payment');
  });

  it('checks the signature even for an order that is already paid', async () => {
    const o = await pendingOrder();
    const pay = ledger.simulatePayment(o.providerOrderId);
    await verify(o, verifyBody(o, pay));
    const res = await verify(o, verifyBody(o, pay, { razorpaySignature: '0'.repeat(64) }));
    expect(res.status).toBe(400);
  });

  it('is limited to the order owner (404), customers (403) and logged-in users (401)', async () => {
    const o = await pendingOrder();
    const pay = ledger.simulatePayment(o.providerOrderId);
    const other = await signUp(app, 'other@example.com');
    expect((await verify(o, verifyBody(o, pay), other.auth)).status).toBe(404);
    const admin = await makeAdmin(app);
    expect((await verify(o, verifyBody(o, pay), admin.auth)).status).toBe(403);
    expect((await verify(o, verifyBody(o, pay), {})).status).toBe(401);
    expect((await orderOf(o)).status).toBe('pending_payment');
  });

  it('rejects unknown fields and a malformed order id', async () => {
    const o = await pendingOrder();
    const pay = ledger.simulatePayment(o.providerOrderId);
    expect((await verify(o, { ...verifyBody(o, pay), amountPaise: 1 })).status).toBe(422);
    expect((await verify(o, verifyBody(o, pay, { orderId: 'nope' }))).status).toBe(422);
  });
});

describe('POST /payments/mock/complete (development only)', () => {
  it('returns what Checkout would hand to the browser, and verify accepts it', async () => {
    const o = await pendingOrder();
    const res = await api(app, 'post', '/payments/mock/complete', o.customer.auth, {
      orderId: o.orderId,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.razorpayOrderId).toBe(o.providerOrderId);
    const verified = await api(app, 'post', '/payments/verify', o.customer.auth, {
      orderId: o.orderId,
      ...res.body.data,
    });
    expect(verified.body.data.status).toBe('placed');
  });

  it('is a 404 in production and for any provider other than the mock', async () => {
    const o = await pendingOrder();
    const prod = buildTestApp({ paymentProvider: ledger, nodeEnv: 'production' });
    expect(
      (await api(prod, 'post', '/payments/mock/complete', o.customer.auth, { orderId: o.orderId }))
        .status,
    ).toBe(404);
    const real = buildTestApp({ paymentProvider: { ...ledger, name: 'razorpay' } });
    expect(
      (await api(real, 'post', '/payments/mock/complete', o.customer.auth, { orderId: o.orderId }))
        .status,
    ).toBe(404);
  });

  it('does not work on another customer’s order', async () => {
    const o = await pendingOrder();
    const other = await signUp(app, 'other@example.com');
    expect(
      (await api(app, 'post', '/payments/mock/complete', other.auth, { orderId: o.orderId }))
        .status,
    ).toBe(404);
  });
});

describe('POST /webhooks/razorpay', () => {
  it('payment.captured marks the order paid and stores one event row keyed by the header', async () => {
    const o = await pendingOrder();
    const pay = ledger.simulatePayment(o.providerOrderId);
    const res = await sendWebhook(hookFor(o, pay, 'payment.captured', 'evt_A1'));
    expect(res.status).toBe(200);
    expect((await orderOf(o)).status).toBe('placed');
    expect(await Payment.findOne({ orderId: o.orderId })).toMatchObject({
      status: 'captured',
      confirmedVia: 'webhook',
    });
    const rows = await WebhookEvent.find();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'razorpay',
      eventId: 'evt_A1',
      eventType: 'payment.captured',
      status: 'processed',
      attempts: 1,
    });
  });

  it('delivered 3 times: the order changes once, one row, stock and coupon counters unchanged afterwards', async () => {
    const o = await pendingOrder({ coupon: true });
    const pay = ledger.simulatePayment(o.providerOrderId);
    const hook = hookFor(o, pay, 'payment.captured', 'evt_dup');
    const coupon = await Coupon.findOne({ code: 'SAVE5' });
    const before = {
      stock: (await Product.findById(o.product.id)).stockQty,
      used: coupon.usedCount,
    };

    for (let i = 0; i < 3; i++) expect((await sendWebhook(hook)).status).toBe(200);
    expect(await WebhookEvent.countDocuments()).toBe(1);
    expect(ledger.state.calls.filter((c) => c.method === 'fetchPayment')).toHaveLength(1);
    expect((await orderOf(o)).status).toBe('placed');
    expect((await SubOrder.findOne({ orderId: o.orderId })).statusHistory).toHaveLength(2);
    expect((await Product.findById(o.product.id)).stockQty).toBe(before.stock);
    expect((await Coupon.findById(coupon.id)).usedCount).toBe(before.used);
    expect(await CouponRedemption.countDocuments({ status: 'redeemed' })).toBe(1);
  });

  it('delivered concurrently with /payments/verify: the order transitions once', async () => {
    const o = await pendingOrder({ coupon: true });
    const pay = ledger.simulatePayment(o.providerOrderId);
    const hook = hookFor(o, pay, 'payment.captured', 'evt_race');
    const results = await Promise.all([
      sendWebhook(hook),
      verify(o, verifyBody(o, pay)),
      sendWebhook(hook),
      verify(o, verifyBody(o, pay)),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect((await orderOf(o)).status).toBe('placed');
    expect(
      (await SubOrder.findOne({ orderId: o.orderId })).statusHistory.map((h) => h.status),
    ).toEqual(['pending_payment', 'processing']);
    expect(await CouponRedemption.countDocuments({ status: 'redeemed' })).toBe(1);
    expect(await WebhookEvent.countDocuments()).toBe(1);
  });

  it('order.paid then payment.captured (out of order or both sent) is safe', async () => {
    const o = await pendingOrder();
    const pay = ledger.simulatePayment(o.providerOrderId);
    expect((await sendWebhook(hookFor(o, pay, 'order.paid'))).status).toBe(200);
    expect((await sendWebhook(hookFor(o, pay, 'payment.captured'))).status).toBe(200);
    expect((await orderOf(o)).status).toBe('placed');
    expect((await WebhookEvent.find()).map((r) => r.status)).toEqual(['processed', 'processed']);
  });

  it('a late payment.failed never undoes a capture; a failure before a capture does not block it', async () => {
    const o = await pendingOrder();
    const bad = ledger.simulatePayment(o.providerOrderId, { status: 'failed' });
    await sendWebhook(hookFor(o, bad, 'payment.failed'));
    expect(await Payment.findOne({ orderId: o.orderId })).toMatchObject({ status: 'failed' });
    expect((await orderOf(o)).status).toBe('pending_payment');

    const good = ledger.simulatePayment(o.providerOrderId);
    await sendWebhook(hookFor(o, good, 'payment.captured'));
    expect((await orderOf(o)).status).toBe('placed');
    expect((await Payment.findOne({ orderId: o.orderId })).status).toBe('captured');

    await sendWebhook(hookFor(o, bad, 'payment.failed'));
    expect((await Payment.findOne({ orderId: o.orderId })).status).toBe('captured');
    expect((await orderOf(o)).status).toBe('placed');
  });

  it('never trusts the body: a captured event for a payment the provider reports as authorized changes nothing', async () => {
    const o = await pendingOrder();
    const pay = ledger.simulatePayment(o.providerOrderId, { status: 'authorized' });
    const hook = hookFor(o, pay, 'payment.captured');
    expect((await sendWebhook(hook)).status).toBe(200);
    expect((await orderOf(o)).status).toBe('pending_payment');
  });

  it('a signed event with a wrong amount is answered 200, recorded as failed, and changes nothing', async () => {
    const o = await pendingOrder();
    const pay = ledger.simulatePayment(o.providerOrderId, { amountPaise: 100 });
    expect((await sendWebhook(hookFor(o, pay))).status).toBe(200);
    expect((await orderOf(o)).status).toBe('pending_payment');
    expect(await WebhookEvent.findOne()).toMatchObject({ status: 'failed' });
  });

  it('stores unknown events and unknown orders as ignored (still 200)', async () => {
    const o = await pendingOrder();
    const pay = ledger.simulatePayment(o.providerOrderId);
    await sendWebhook(hookFor(o, pay, 'payment.authorized'));
    await sendWebhook(hookFor(o, pay, 'refund.processed'));
    await sendWebhook(hookFor({ providerOrderId: 'order_other_1' }, pay, 'payment.captured'));
    expect((await WebhookEvent.find().sort({ receivedAt: 1 })).map((r) => r.status)).toEqual([
      'ignored',
      'ignored',
      'ignored',
    ]);
    expect((await orderOf(o)).status).toBe('pending_payment');
  });

  describe('rejects with 400 and stores nothing', () => {
    it.each([
      [
        'a missing signature',
        (h) => {
          delete h.headers['x-razorpay-signature'];
        },
      ],
      [
        'a wrong signature',
        (h) => {
          h.headers['x-razorpay-signature'] = '0'.repeat(64);
        },
      ],
      [
        'a body changed after signing',
        (h) => {
          h.rawBody = Buffer.from(h.rawBody.toString().replace('captured', 'captureD'));
        },
      ],
    ])('%s', async (_name, tamper) => {
      const o = await pendingOrder();
      const hook = hookFor(o, ledger.simulatePayment(o.providerOrderId));
      tamper(hook);
      const res = await sendWebhook(hook);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
      expect(await WebhookEvent.countDocuments()).toBe(0);
      expect((await orderOf(o)).status).toBe('pending_payment');
    });

    it('a signed request without an event id, or with a body that is not JSON', async () => {
      const o = await pendingOrder();
      const hook = hookFor(o, ledger.simulatePayment(o.providerOrderId));
      delete hook.headers['x-razorpay-event-id'];
      expect((await sendWebhook(hook)).status).toBe(400);

      const raw = Buffer.from('this is not json');
      const signed = {
        rawBody: raw,
        headers: {
          'content-type': 'application/json',
          'x-razorpay-event-id': 'evt_bad',
          'x-razorpay-signature': webhookSignature({
            rawBody: raw,
            webhookSecret: ledger.secrets.webhookSecret,
          }),
        },
      };
      expect((await sendWebhook(signed)).status).toBe(400);
      expect(await WebhookEvent.countDocuments()).toBe(0);
    });
  });

  it('needs no login (the signature is the authentication) and no CORS or rate-limit state', async () => {
    const o = await pendingOrder();
    const res = await sendWebhook(hookFor(o, ledger.simulatePayment(o.providerOrderId)));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { received: true } });
  });
});

describe('atomic claiming of duplicate events (D46)', () => {
  const fetchCalls = () => ledger.state.calls.filter((c) => c.method === 'fetchPayment').length;

  it('20 concurrent deliveries of one new event run the handler exactly once', async () => {
    const o = await pendingOrder();
    const hook = hookFor(
      o,
      ledger.simulatePayment(o.providerOrderId),
      'payment.captured',
      'evt_20',
    );
    const results = await Promise.all(Array.from({ length: 20 }, () => sendWebhook(hook)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(fetchCalls()).toBe(1);
    expect(await WebhookEvent.countDocuments()).toBe(1);
    expect((await orderOf(o)).status).toBe('placed');
  });

  it('a `failed` row is taken over by a redelivery, and 20 concurrent redeliveries process it once', async () => {
    const o = await pendingOrder();
    const hook = hookFor(
      o,
      ledger.simulatePayment(o.providerOrderId),
      'payment.captured',
      'evt_failed',
    );
    await WebhookEvent.create({
      provider: 'razorpay',
      eventId: 'evt_failed',
      eventType: 'payment.captured',
      status: 'failed',
      error: 'db down',
    });
    const results = await Promise.all(Array.from({ length: 20 }, () => sendWebhook(hook)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(fetchCalls()).toBe(1);
    expect(await WebhookEvent.findOne({ eventId: 'evt_failed' })).toMatchObject({
      status: 'processed',
      attempts: 2,
    });
    expect((await orderOf(o)).status).toBe('placed');
  });

  it('a `received` row older than 60 s (owner crashed) is taken over exactly once', async () => {
    const o = await pendingOrder();
    const hook = hookFor(
      o,
      ledger.simulatePayment(o.providerOrderId),
      'payment.captured',
      'evt_stale',
    );
    await WebhookEvent.create({
      provider: 'razorpay',
      eventId: 'evt_stale',
      eventType: 'payment.captured',
      status: 'received',
      claimedAt: new Date(Date.now() - 120_000),
    });
    const results = await Promise.all(Array.from({ length: 20 }, () => sendWebhook(hook)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(fetchCalls()).toBe(1);
    expect(await WebhookEvent.findOne({ eventId: 'evt_stale' })).toMatchObject({
      status: 'processed',
      attempts: 2,
    });
  });

  it('a `received` row claimed a moment ago belongs to its owner: redeliveries do nothing', async () => {
    const o = await pendingOrder();
    const hook = hookFor(
      o,
      ledger.simulatePayment(o.providerOrderId),
      'payment.captured',
      'evt_busy',
    );
    await WebhookEvent.create({
      provider: 'razorpay',
      eventId: 'evt_busy',
      eventType: 'payment.captured',
      status: 'received',
    });
    const results = await Promise.all(Array.from({ length: 5 }, () => sendWebhook(hook)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(fetchCalls()).toBe(0);
    expect((await orderOf(o)).status).toBe('pending_payment');
    expect(await WebhookEvent.findOne({ eventId: 'evt_busy' })).toMatchObject({
      status: 'received',
      attempts: 1,
    });
  });

  it('processed and ignored rows are never reprocessed', async () => {
    const o = await pendingOrder();
    const hook = hookFor(
      o,
      ledger.simulatePayment(o.providerOrderId),
      'payment.captured',
      'evt_done',
    );
    await WebhookEvent.create({
      provider: 'razorpay',
      eventId: 'evt_done',
      eventType: 'payment.captured',
      status: 'processed',
      claimedAt: new Date(Date.now() - 3_600_000),
    });
    expect((await sendWebhook(hook)).status).toBe(200);
    expect(fetchCalls()).toBe(0);
  });
});

describe('late capture on an expired order (ARCHITECTURE 3.1 step 7)', () => {
  const lifecycle = () =>
    createOrderLifecycle({
      searchOutbox: createSearchOutbox(),
      cache: createCache({ redis: null, logger: silentLogger }),
      logger: silentLogger,
    });

  it('re-reserves the stock and places the order when the stock is still there', async () => {
    const o = await pendingOrder({ coupon: true });
    await lifecycle().expireOrder(o.orderId);
    expect((await orderOf(o)).status).toBe('expired');
    expect((await Product.findById(o.product.id)).stockQty).toBe(20);
    expect((await Coupon.findOne({ code: 'SAVE5' })).usedCount).toBe(0);

    const pay = ledger.simulatePayment(o.providerOrderId);
    expect((await sendWebhook(hookFor(o, pay))).status).toBe(200);
    const order = await orderOf(o);
    expect(order).toMatchObject({ status: 'placed', paymentStatus: 'paid' });
    expect((await Product.findById(o.product.id)).stockQty).toBe(18);
    expect((await Coupon.findOne({ code: 'SAVE5' })).usedCount).toBe(1);
    expect(await CouponRedemption.findOne({ orderId: o.orderId })).toMatchObject({
      status: 'redeemed',
    });
    const sub = await SubOrder.findOne({ orderId: o.orderId });
    expect(sub).toMatchObject({ fulfillmentStatus: 'processing', stockRestored: false });
    expect(await Refund.countDocuments()).toBe(0);
  });

  it('refunds the customer in full when the stock is gone, exactly once', async () => {
    const o = await pendingOrder({ stock: 2, quantity: 2 });
    await lifecycle().expireOrder(o.orderId);
    await Product.updateOne({ _id: o.product.id }, { stockQty: 1 }); // someone else bought the units

    const pay = ledger.simulatePayment(o.providerOrderId);
    const hook = hookFor(o, pay, 'payment.captured', 'evt_late');
    const [a, b, c] = await Promise.all([
      sendWebhook(hook),
      verify(o, verifyBody(o, pay)),
      sendWebhook(hookFor(o, pay, 'order.paid')),
    ]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);

    const order = await orderOf(o);
    expect(order).toMatchObject({ status: 'expired', paymentStatus: 'paid', refundStatus: 'full' });
    expect((await Product.findById(o.product.id)).stockQty).toBe(1); // untouched, never negative
    const refunds = await Refund.find();
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      reason: 'failed_late_capture',
      status: 'processed',
      amountPaise: o.totalPaise,
      idempotencyKey: `late_capture:${(await Payment.findOne({ orderId: o.orderId })).id}`,
    });
    expect(refunds[0].providerRefundId).toMatch(/^rfnd_mock_/);
    expect(await Payment.findOne({ orderId: o.orderId })).toMatchObject({ status: 'captured' });
    const calls = ledger.state.calls.filter((x) => x.method === 'refundPayment');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({ amountPaise: o.totalPaise, reverseAll: true });
  });

  it('a refund the provider could not make stays `initiated` and is finished by a retry', async () => {
    const o = await pendingOrder({ stock: 2, quantity: 2 });
    await lifecycle().expireOrder(o.orderId);
    await Product.updateOne({ _id: o.product.id }, { stockQty: 0 });
    const pay = ledger.simulatePayment(o.providerOrderId);
    ledger.failNext('refundPayment');
    await sendWebhook(hookFor(o, pay));
    expect(await Refund.findOne()).toMatchObject({ status: 'initiated' });
    expect(await orderOf(o)).toMatchObject({ status: 'expired', refundStatus: 'none' });

    // a redelivered event (same payment) retries the refund and does not create a second one
    await sendWebhook(hookFor(o, pay, 'order.paid'));
    expect(await Refund.countDocuments()).toBe(1);
    expect(await Refund.findOne()).toMatchObject({ status: 'processed' });
    expect(await orderOf(o)).toMatchObject({ refundStatus: 'full' });
  });
});
