import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Product } from '../src/modules/catalog/products.model.js';
import { Order, SubOrder } from '../src/modules/orders/orders.model.js';
import { Refund } from '../src/modules/refunds/refunds.model.js';
import { createMockLedger } from '../src/providers/payment/mockLedger.js';
import { clearDb, startTestDb, stopTestDb } from './db.js';
import { buildTestApp } from './helpers.js';
import { api } from './phase5.helpers.js';
import {
  deliver,
  orderOf,
  paidOrder,
  setStatus,
  settlementOf,
  subOrderOf,
  TRACKING,
} from './phase6.helpers.js';

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

const STATES = ['pending_payment', 'processing', 'shipped', 'delivered', 'cancelled'];
// from -> to -> expected HTTP status when the VENDOR asks (API_CONTRACTS section 3).
const ALLOWED = new Set(['processing>shipped', 'shipped>delivered', 'processing>cancelled']);

describe('vendor status flow: the transition table', () => {
  const pairs = STATES.flatMap((from) => STATES.map((to) => [from, to]));

  it.each(pairs)('%s -> %s', async (from, to) => {
    const o = await paidOrder(app, ledger);
    // Put the sub-order in `from` directly (the API cannot reach every state).
    const subId = o.subs[0].id;
    await SubOrder.updateOne(
      { _id: subId },
      {
        fulfillmentStatus: from,
        ...(from === 'delivered' && { returnWindowEndsAt: new Date(Date.now() + 1e9) }),
      },
    );
    const body = to === 'shipped' ? { status: to, tracking: TRACKING } : { status: to };
    const res = await setStatus(app, o.vendors[0], subId, body);
    if (ALLOWED.has(`${from}>${to}`)) {
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.fulfillmentStatus).toBe(to);
    } else {
      expect(res.status, `${from} -> ${to}`).toBe(409);
      expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
      expect((await subOrderOf(subId)).fulfillmentStatus).toBe(from); // unchanged
    }
  });
});

describe('vendor sub-order endpoints', () => {
  it('shipping needs tracking, and tracking is only for shipping (422)', async () => {
    const o = await paidOrder(app, ledger);
    const id = o.subs[0].id;
    expect((await setStatus(app, o.vendors[0], id, { status: 'shipped' })).status).toBe(422);
    const res = await setStatus(app, o.vendors[0], id, { status: 'cancelled', tracking: TRACKING });
    expect(res.status).toBe(422);
    expect((await subOrderOf(id)).fulfillmentStatus).toBe('processing');
  });

  it("another vendor's sub-order is a 404 for read and write (D15)", async () => {
    const o = await paidOrder(app, ledger, { vendorCount: 2 });
    const [a, b] = o.vendors;
    const bSub = o.subs[1].id;
    expect((await api(app, 'get', `/vendor/sub-orders/${bSub}`, a.auth)).status).toBe(404);
    expect((await setStatus(app, a, bSub, { status: 'shipped', tracking: TRACKING })).status).toBe(
      404,
    );
    expect((await api(app, 'get', `/vendor/sub-orders/${bSub}`, b.auth)).status).toBe(200);
    expect((await subOrderOf(bSub)).fulfillmentStatus).toBe('processing');
  });

  it('lists only own paid sub-orders, filtered by status, and shows no customer identity', async () => {
    const o = await paidOrder(app, ledger, { vendorCount: 2 });
    const res = await api(app, 'get', '/vendor/sub-orders', o.vendors[0].auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const view = res.body.data[0];
    expect(view.shippingAddress.line1).toBe('12 Lake Rd');
    expect(JSON.stringify(view)).not.toMatch(/customerId|email|passwordHash/);
    const shipped = await api(
      app,
      'get',
      '/vendor/sub-orders?fulfillmentStatus=shipped',
      o.vendors[0].auth,
    );
    expect(shipped.body.data).toHaveLength(0);
    expect(res.body.meta.total).toBe(1);
  });

  it('never shows a vendor the sub-orders of an order that was not paid', async () => {
    const o = await paidOrder(app, ledger);
    await SubOrder.updateMany(
      {},
      { $set: { statusHistory: [{ status: 'pending_payment', at: new Date() }] } },
    );
    const res = await api(app, 'get', '/vendor/sub-orders', o.vendors[0].auth);
    expect(res.body.data).toHaveLength(0);
  });

  it('a vendor that is not approved cannot change a status (403 VENDOR_NOT_APPROVED)', async () => {
    const o = await paidOrder(app, ledger);
    const { Vendor } = await import('../src/modules/shops/shops.model.js');
    await Vendor.updateOne({ _id: o.vendors[0].shop.id }, { status: 'suspended' });
    const res = await setStatus(app, o.vendors[0], o.subs[0].id, {
      status: 'shipped',
      tracking: TRACKING,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('VENDOR_NOT_APPROVED');
  });

  it('a vendor with no shop profile gets 403 (loadShop)', async () => {
    const o = await paidOrder(app, ledger);
    const { signUp } = await import('./factories.js');
    // a second vendor user without a shop
    const lone = await signUp(app, 'lone@example.com', 'register-vendor');
    expect((await api(app, 'get', `/vendor/sub-orders/${o.subs[0].id}`, lone.auth)).status).toBe(
      403,
    );
  });
});

describe('delivery', () => {
  it('sets deliveredAt, a 7-day return window and moves the settlement to pending_release', async () => {
    const o = await paidOrder(app, ledger);
    const before = await settlementOf(o.subs[0].id);
    expect(before.status).toBe('not_eligible');
    const view = await deliver(app, o.vendors[0], o.subs[0].id);
    const sub = await subOrderOf(o.subs[0].id);
    expect(sub.deliveredAt).toBeInstanceOf(Date);
    expect(sub.returnWindowEndsAt.getTime() - sub.deliveredAt.getTime()).toBe(7 * 86_400_000);
    expect(view.returnWindowEndsAt).toBeTruthy();
    const after = await settlementOf(o.subs[0].id);
    expect(after.status).toBe('pending_release');
    expect(after.eligibleAt.getTime()).toBe(sub.returnWindowEndsAt.getTime());
  });

  it('shipping alone does not make the settlement eligible', async () => {
    const o = await paidOrder(app, ledger);
    await setStatus(app, o.vendors[0], o.subs[0].id, { status: 'shipped', tracking: TRACKING });
    expect((await settlementOf(o.subs[0].id)).status).toBe('not_eligible');
    expect((await subOrderOf(o.subs[0].id)).tracking.trackingNumber).toBe('D123456');
  });

  it('the order is completed only when every sub-order is delivered or cancelled', async () => {
    const o = await paidOrder(app, ledger, { vendorCount: 2 });
    await deliver(app, o.vendors[0], o.subs[0].id);
    expect((await orderOf(o.orderId)).status).toBe('placed');
    const res = await setStatus(app, o.vendors[1], o.subs[1].id, { status: 'cancelled' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await orderOf(o.orderId)).status).toBe('completed');
  });

  it('the same transition sent twice at once changes the sub-order once', async () => {
    const o = await paidOrder(app, ledger);
    const send = () =>
      setStatus(app, o.vendors[0], o.subs[0].id, { status: 'shipped', tracking: TRACKING });
    const results = await Promise.all([send(), send(), send()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const sub = await subOrderOf(o.subs[0].id);
    expect(sub.statusHistory.filter((h) => h.status === 'shipped')).toHaveLength(1);
  });
});

describe('cancel before shipping', () => {
  const stockOf = async (o) => (await Product.findById(o.products[0].id)).stockQty;
  const cancel = (o, auth = o.customer.auth, subIdx = 0) =>
    api(app, 'post', `/orders/${o.orderId}/sub-orders/${o.subs[subIdx].id}/cancel`, auth, {});

  it('restores stock exactly once, refunds in full, reverses the settlement', async () => {
    const o = await paidOrder(app, ledger, { quantities: [3] });
    expect(await stockOf(o)).toBe(17);
    const res = await cancel(o);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await stockOf(o)).toBe(20);
    const sub = await subOrderOf(o.subs[0].id);
    expect(sub.fulfillmentStatus).toBe('cancelled');
    expect(sub.stockRestored).toBe(true);
    expect(sub.refundedPaise).toBe(sub.customerTotalPaise);
    expect(sub.refundStatus).toBe('full');
    const s = await settlementOf(sub.id);
    expect(s.status).toBe('reversed');
    expect(s.netPayoutPaise).toBe(0);
    const refund = await Refund.findOne({ subOrderId: sub.id });
    expect(refund.reason).toBe('customer_cancel');
    expect(refund.status).toBe('processed');
    expect(refund.commissionReversedPaise).toBe(sub.commission.amountPaise);
    expect(refund.vendorDebitPaise).toBe(sub.vendorPayoutPaise);
    expect(res.body.data.order.subOrders[0].fulfillmentStatus).toBe('cancelled');
    expect((await orderOf(o.orderId)).status).toBe('cancelled');
    expect((await orderOf(o.orderId)).refundStatus).toBe('full');
  });

  it('double call: the second answers 409 and nothing is restocked or refunded again', async () => {
    const o = await paidOrder(app, ledger);
    expect((await cancel(o)).status).toBe(200);
    const again = await cancel(o);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await stockOf(o)).toBe(20);
    expect(await Refund.countDocuments({ subOrderId: o.subs[0].id })).toBe(1);
    expect(ledger.state.calls.filter((c) => c.method === 'refundPayment')).toHaveLength(1);
  });

  it('concurrent cancels (customer + vendor + customer): one wins, stock restored once', async () => {
    const o = await paidOrder(app, ledger, { quantities: [4] });
    const results = await Promise.all([
      cancel(o),
      setStatus(app, o.vendors[0], o.subs[0].id, { status: 'cancelled' }),
      cancel(o),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await stockOf(o)).toBe(20);
    expect(await Refund.countDocuments({ subOrderId: o.subs[0].id })).toBe(1);
  });

  it('a vendor can cancel an unshipped sub-order (reason vendor_cancel)', async () => {
    const o = await paidOrder(app, ledger);
    const res = await setStatus(app, o.vendors[0], o.subs[0].id, { status: 'cancelled' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await Refund.findOne({ subOrderId: o.subs[0].id })).reason).toBe('vendor_cancel');
    expect(await stockOf(o)).toBe(20);
  });

  it('cannot cancel once shipped (409), nothing changes', async () => {
    const o = await paidOrder(app, ledger);
    await setStatus(app, o.vendors[0], o.subs[0].id, { status: 'shipped', tracking: TRACKING });
    expect((await cancel(o)).status).toBe(409);
    expect(await stockOf(o)).toBe(18);
    expect(await Refund.countDocuments()).toBe(0);
  });

  it("another customer's sub-order is a 404", async () => {
    const o = await paidOrder(app, ledger);
    const { signUp } = await import('./factories.js');
    const other = await signUp(app, 'other@example.com');
    expect((await cancel(o, other.auth)).status).toBe(404);
    expect((await subOrderOf(o.subs[0].id)).fulfillmentStatus).toBe('processing');
    // right customer, wrong order id in the path
    const wrongOrder = await api(
      app,
      'post',
      `/orders/${'a'.repeat(24)}/sub-orders/${o.subs[0].id}/cancel`,
      o.customer.auth,
      {},
    );
    expect(wrongOrder.status).toBe(404);
  });

  it('cancelling one of two sub-orders leaves the order placed and the other untouched', async () => {
    const o = await paidOrder(app, ledger, { vendorCount: 2 });
    expect((await cancel(o, o.customer.auth, 0)).status).toBe(200);
    expect((await orderOf(o.orderId)).status).toBe('placed');
    expect((await orderOf(o.orderId)).refundStatus).toBe('partial');
    expect((await subOrderOf(o.subs[1].id)).fulfillmentStatus).toBe('processing');
    expect((await Order.findById(o.orderId)).paymentStatus).toBe('paid');
  });

  it('when the provider is down the cancel still stands and the refund waits (initiated)', async () => {
    const o = await paidOrder(app, ledger);
    ledger.failNext('reverseTransfer');
    const res = await cancel(o);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await subOrderOf(o.subs[0].id)).fulfillmentStatus).toBe('cancelled');
    const refund = await Refund.findOne({ subOrderId: o.subs[0].id });
    expect(refund.status).toBe('initiated');
    expect(refund.providerReversalId).toBeUndefined();
    expect((await subOrderOf(o.subs[0].id)).refundStatus).toBe('pending');
  });
});
