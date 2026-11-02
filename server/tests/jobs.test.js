import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createJobLocks } from '../src/jobs/jobLock.js';
import { createReconcilePendingJob } from '../src/jobs/reconcilePending.js';
import { createReservationReleaseJob } from '../src/jobs/reservationRelease.js';
import { Product } from '../src/modules/catalog/products.model.js';
import { Coupon } from '../src/modules/coupons/coupons.model.js';
import { CouponRedemption } from '../src/modules/coupons/redemptions.model.js';
import { Order, SubOrder } from '../src/modules/orders/orders.model.js';
import { Payment } from '../src/modules/payments/payments.model.js';
import { Refund } from '../src/modules/refunds/refunds.model.js';
import { createMockLedger } from '../src/providers/payment/mockLedger.js';
import { clearDb, startTestDb, stopTestDb } from './db.js';
import { buildTestApp, silentLogger } from './helpers.js';
import { addProduct, api, checkout, fillCart, makeCoupon, setupMarket } from './phase5.helpers.js';

let replSet;
let app;
let ledger;
let services;
beforeAll(async () => {
  replSet = await startTestDb();
}, 60_000);
afterAll(() => stopTestDb(replSet));
beforeEach(async () => {
  await clearDb();
  ledger = createMockLedger();
  app = buildTestApp({ paymentProvider: ledger });
  services = app.get('paymentServices');
});

const MIN = 60_000;
const jobs = (clock = () => new Date()) => ({
  release: createReservationReleaseJob({
    ...services,
    jobLocks: createJobLocks(),
    logger: silentLogger,
    clock,
  }),
  reconcile: createReconcilePendingJob({
    ...services,
    jobLocks: createJobLocks(),
    logger: silentLogger,
    clock,
  }),
});

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
    expiresAt: new Date(res.body.data.order.reservationExpiresAt),
  };
}
const orderOf = (o) => Order.findById(o.orderId);
const stockOf = async (o) => (await Product.findById(o.product.id)).stockQty;

describe('reservation release job', () => {
  it('expires an unpaid order within 16 minutes and restores stock and coupon exactly once', async () => {
    const o = await pendingOrder({ coupon: true });
    const coupon = await Coupon.findOne({ code: 'SAVE5' });
    expect(await stockOf(o)).toBe(18);
    expect(coupon.usedCount).toBe(1);

    const created = o.expiresAt.getTime() - 15 * MIN;
    const at = (minutes) => jobs(() => new Date(created + minutes * MIN)).release;

    expect(await at(14).tick()).toMatchObject({ expired: 0 }); // still reserved
    expect((await orderOf(o)).status).toBe('pending_payment');

    expect(await at(16).tick()).toMatchObject({ expired: 1 }); // due
    expect(await orderOf(o)).toMatchObject({ status: 'expired', paymentStatus: 'unpaid' });
    expect(await stockOf(o)).toBe(20);
    expect((await Coupon.findById(coupon.id)).usedCount).toBe(0);
    expect(await CouponRedemption.findOne({ orderId: o.orderId })).toMatchObject({
      status: 'released',
    });
    const sub = await SubOrder.findOne({ orderId: o.orderId });
    expect(sub).toMatchObject({ fulfillmentStatus: 'cancelled', stockRestored: true });

    // running again changes nothing
    expect(await at(30).tick()).toMatchObject({ expired: 0 });
    expect(await stockOf(o)).toBe(20);
    expect((await Coupon.findById(coupon.id)).usedCount).toBe(0);
  });

  it('five racing expirations of one order restore the stock once', async () => {
    const o = await pendingOrder({ coupon: true });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => services.lifecycle.expireOrder(o.orderId)),
    );
    expect(results.filter((r) => r.expired)).toHaveLength(1);
    expect(await stockOf(o)).toBe(20); // not 28
    expect((await Coupon.findOne({ code: 'SAVE5' })).usedCount).toBe(0);
  });

  it('does not expire an order that has been paid', async () => {
    const o = await pendingOrder();
    const pay = ledger.simulatePayment(o.providerOrderId);
    await api(app, 'post', '/payments/verify', o.customer.auth, {
      orderId: o.orderId,
      razorpayOrderId: o.providerOrderId,
      razorpayPaymentId: pay.providerPaymentId,
      razorpaySignature: pay.signature,
    });
    await Order.updateOne({ _id: o.orderId }, { reservationExpiresAt: new Date(Date.now() - MIN) });
    expect(await jobs().release.tick()).toMatchObject({ expired: 0 });
    expect((await orderOf(o)).status).toBe('placed');
    expect(await stockOf(o)).toBe(18);
  });

  it('confirms instead of expiring when the provider shows the customer paid (lost webhook, closed tab)', async () => {
    const o = await pendingOrder();
    ledger.simulatePayment(o.providerOrderId); // captured at the provider; nobody told us
    await Order.updateOne({ _id: o.orderId }, { reservationExpiresAt: new Date(Date.now() - MIN) });
    expect(await jobs().release.tick()).toMatchObject({ expired: 0, confirmed: 1 });
    expect(await orderOf(o)).toMatchObject({ status: 'placed', paymentStatus: 'paid' });
    expect(await Payment.findOne({ orderId: o.orderId })).toMatchObject({
      confirmedVia: 'reconcile',
    });
  });

  it('expires the order even if the provider cannot be reached', async () => {
    const o = await pendingOrder();
    await Order.updateOne({ _id: o.orderId }, { reservationExpiresAt: new Date(Date.now() - MIN) });
    ledger.failNext('fetchOrderPayments');
    expect(await jobs().release.tick()).toMatchObject({ expired: 1 });
    expect((await orderOf(o)).status).toBe('expired');
  });

  it('is lease-guarded: of two instances ticking at once, only one runs', async () => {
    const o = await pendingOrder();
    await Order.updateOne({ _id: o.orderId }, { reservationExpiresAt: new Date(Date.now() - MIN) });
    const [a, b] = [jobs().release, jobs().release];
    const results = await Promise.all([a.tick(), b.tick()]);
    expect(results.filter((r) => r.skipped)).toHaveLength(1);
    expect(results.find((r) => !r.skipped)).toMatchObject({ expired: 1 });
    expect(await stockOf(o)).toBe(20);
  });
});

describe('reconcile job', () => {
  it('confirms a paid order older than 5 minutes whose webhook and browser report never arrived', async () => {
    const o = await pendingOrder();
    ledger.simulatePayment(o.providerOrderId);
    const created = o.expiresAt.getTime() - 15 * MIN;

    expect(await jobs(() => new Date(created + 2 * MIN)).reconcile.tick()).toMatchObject({
      checked: 0,
    }); // too young
    expect((await orderOf(o)).status).toBe('pending_payment');

    expect(await jobs(() => new Date(created + 6 * MIN)).reconcile.tick()).toMatchObject({
      checked: 1,
      confirmed: 1,
    });
    expect(await orderOf(o)).toMatchObject({ status: 'placed', paymentStatus: 'paid' });
    expect(await Payment.findOne({ orderId: o.orderId })).toMatchObject({
      status: 'captured',
      confirmedVia: 'reconcile',
    });
  });

  it('leaves an unpaid or only-authorized order alone', async () => {
    const a = await pendingOrder();
    const created = a.expiresAt.getTime() - 15 * MIN;
    const job = jobs(() => new Date(created + 6 * MIN)).reconcile;
    expect(await job.tick()).toMatchObject({ checked: 1, confirmed: 0 });
    ledger.simulatePayment(a.providerOrderId, { status: 'authorized' });
    expect(await job.tick()).toMatchObject({ checked: 1, confirmed: 0 });
    expect((await orderOf(a)).status).toBe('pending_payment');
  });

  it('catches a late capture on an order that has already expired (lost webhook): re-reserves the stock', async () => {
    const o = await pendingOrder();
    await services.lifecycle.expireOrder(o.orderId);
    expect(await stockOf(o)).toBe(20);
    ledger.simulatePayment(o.providerOrderId);
    expect(await jobs().reconcile.tick()).toMatchObject({ confirmed: 1 });
    expect(await orderOf(o)).toMatchObject({ status: 'placed', paymentStatus: 'paid' });
    expect(await stockOf(o)).toBe(18);
  });

  it('refunds a late capture with no stock left (acceptance: automatic full refund record)', async () => {
    const o = await pendingOrder({ stock: 2, quantity: 2 });
    await services.lifecycle.expireOrder(o.orderId);
    await Product.updateOne({ _id: o.product.id }, { stockQty: 0 });
    ledger.simulatePayment(o.providerOrderId);
    await jobs().reconcile.tick();
    expect(await Refund.findOne()).toMatchObject({
      reason: 'failed_late_capture',
      status: 'processed',
    });
    expect(await orderOf(o)).toMatchObject({ status: 'expired', refundStatus: 'full' });
    expect(await stockOf(o)).toBe(0);
    // another pass does not refund twice
    await jobs().reconcile.tick();
    expect(ledger.state.calls.filter((c) => c.method === 'refundPayment')).toHaveLength(1);
  });

  it('retries a refund the provider had refused', async () => {
    const o = await pendingOrder({ stock: 2, quantity: 2 });
    await services.lifecycle.expireOrder(o.orderId);
    await Product.updateOne({ _id: o.product.id }, { stockQty: 0 });
    ledger.simulatePayment(o.providerOrderId);

    // the provider refuses every refund during the first pass
    const realRefund = ledger.refundPayment;
    ledger.refundPayment = async () => {
      throw new Error('provider down');
    };
    await jobs().reconcile.tick();
    expect(await Refund.findOne()).toMatchObject({ status: 'initiated' });
    expect(await orderOf(o)).toMatchObject({ status: 'expired', refundStatus: 'none' });

    // the provider is back: the next pass finishes it, and only once
    ledger.refundPayment = realRefund;
    await jobs().reconcile.tick();
    expect(await Refund.findOne()).toMatchObject({ status: 'processed' });
    expect(await orderOf(o)).toMatchObject({ refundStatus: 'full' });
    expect(await Refund.countDocuments()).toBe(1);
  });

  it('retries an old initiated refund even after the late-capture window has passed', async () => {
    const o = await pendingOrder({ stock: 2, quantity: 2 });
    await services.lifecycle.expireOrder(o.orderId);
    await Product.updateOne({ _id: o.product.id }, { stockQty: 0 });
    ledger.simulatePayment(o.providerOrderId);
    const realRefund = ledger.refundPayment;
    ledger.refundPayment = async () => {
      throw new Error('provider down');
    };
    await jobs().reconcile.tick();
    ledger.refundPayment = realRefund;
    // two hours later the order is no longer polled as a late capture; the refund step still runs
    await Order.collection.updateOne(
      { _id: (await orderOf(o))._id },
      { $set: { updatedAt: new Date(Date.now() - 2 * 60 * MIN) } },
    );
    expect(await jobs().reconcile.tick()).toMatchObject({ checked: 0, refundsRetried: 1 });
    expect(await Refund.findOne()).toMatchObject({ status: 'processed' });
    expect(await orderOf(o)).toMatchObject({ refundStatus: 'full' });
  });

  it('keeps going when the provider fails for one order, and recovers on the next pass', async () => {
    const o = await pendingOrder();
    const created = o.expiresAt.getTime() - 15 * MIN;
    ledger.simulatePayment(o.providerOrderId);
    ledger.failNext('fetchOrderPayments');
    expect(await jobs(() => new Date(created + 6 * MIN)).reconcile.tick()).toMatchObject({
      errors: 1,
      confirmed: 0,
    });
    expect(await jobs(() => new Date(created + 7 * MIN)).reconcile.tick()).toMatchObject({
      confirmed: 1,
    });
  });
});
