import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { Product } from '../src/modules/catalog/products.model.js';
import { Order, SubOrder } from '../src/modules/orders/orders.model.js';
import { Refund } from '../src/modules/refunds/refunds.model.js';
import { createMockLedger } from '../src/providers/payment/mockLedger.js';
import { clearDb, startTestDb, stopTestDb } from './db.js';
import { makeAdmin } from './factories.js';
import { buildTestApp } from './helpers.js';
import { api, checkout, fillCart, addProduct, setupMarket } from './phase5.helpers.js';
import { deliver, orderOf, paidOrder, settlementOf, subOrderOf } from './phase6.helpers.js';

let replSet;
let app;
let ledger;
let admin;
beforeAll(async () => {
  replSet = await startTestDb();
}, 60_000);
afterAll(() => stopTestDb(replSet));
beforeEach(async () => {
  await clearDb();
  ledger = createMockLedger();
  app = buildTestApp({ paymentProvider: ledger });
  admin = await makeAdmin(app);
});

const refund = (subId, body, key) => {
  const req = request(app).post(`/api/v1/admin/sub-orders/${subId}/refund`).set(admin.auth);
  if (key) req.set('Idempotency-Key', key);
  return req.send({ reason: 'admin', note: 'Damaged item', ...body });
};
const calls = (method) => ledger.state.calls.filter((c) => c.method === method);
const webhook = (hook) =>
  request(app)
    .post('/api/v1/webhooks/razorpay')
    .set(hook.headers)
    .send(hook.rawBody.toString('utf8'));

describe('POST /admin/sub-orders/:id/refund', () => {
  it('refunds part of a sub-order: commission reversed proportionally, vendor debited the rest', async () => {
    const o = await paidOrder(app, ledger, { prices: [100000], quantities: [2] }); // total 200000, 10% = 20000
    const sub = o.subs[0];
    const res = await refund(sub.id, { amountPaise: 100000 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.refund).toMatchObject({
      status: 'processed',
      amountPaise: 100000,
      commissionReversedPaise: 10000,
      vendorDebitPaise: 90000,
    });
    expect(res.body.data.subOrder).toMatchObject({
      refundStatus: 'partial',
      refundedPaise: 100000,
      fulfillmentStatus: 'processing',
    });

    const s = await settlementOf(sub.id);
    expect(s.refundAdjustmentPaise).toBe(90000);
    expect(s.netPayoutPaise).toBe(90000);
    expect((await orderOf(o.orderId)).refundStatus).toBe('partial');

    // The vendor transfer is reversed BEFORE the customer is refunded, with the vendor's share.
    const order = ledger.state.calls
      .map((c) => c.method)
      .filter((m) => ['reverseTransfer', 'refundPayment'].includes(m));
    expect(order).toEqual(['reverseTransfer', 'refundPayment']);
    expect(calls('reverseTransfer')[0].args.amountPaise).toBe(90000);
    expect(calls('refundPayment')[0].args).toMatchObject({
      amountPaise: 100000,
      reverseAll: false,
    });
    const transfer = ledger.state.transfers.get(s.providerTransferId);
    expect(transfer.amountReversedPaise).toBe(90000);
  });

  it('three partial refunds and a remainder reconcile commission to the paisa (API level)', async () => {
    const o = await paidOrder(app, ledger, { prices: [33333], quantities: [3] }); // 99999 paise
    const sub = o.subs[0];
    let sumReversed = 0;
    for (const amountPaise of [12345, 23456, 34567]) {
      const res = await refund(sub.id, { amountPaise });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      sumReversed += res.body.data.refund.commissionReversedPaise;
    }
    const last = await refund(sub.id, {}); // no amount = whatever is left
    expect(last.status, JSON.stringify(last.body)).toBe(201);
    sumReversed += last.body.data.refund.commissionReversedPaise;

    const fresh = await subOrderOf(sub.id);
    expect(fresh.refundedPaise).toBe(fresh.customerTotalPaise);
    expect(fresh.refundStatus).toBe('full');
    expect(sumReversed).toBe(fresh.commission.amountPaise);
    const s = await settlementOf(sub.id);
    expect(s.netPayoutPaise).toBe(0);
    expect(s.status).toBe('reversed');
    expect(s.refundAdjustmentPaise).toBe(fresh.vendorPayoutPaise);
    const transfer = ledger.state.transfers.get(s.providerTransferId);
    expect(transfer.amountReversedPaise).toBe(fresh.vendorPayoutPaise); // provider agrees
    expect((await orderOf(o.orderId)).refundStatus).toBe('full');
  });

  it('can never refund more than the customer paid (409), however it is split', async () => {
    const o = await paidOrder(app, ledger, { prices: [10000], quantities: [2] }); // 20000
    const sub = o.subs[0];
    const tooMuch = await refund(sub.id, { amountPaise: 20001 });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.code).toBe('CONFLICT');
    expect(tooMuch.body.error.details).toMatchObject({
      reason: 'exceeds_refundable',
      refundablePaise: 20000,
    });
    expect((await refund(sub.id, { amountPaise: 15000 })).status).toBe(201);
    const second = await refund(sub.id, { amountPaise: 5001 });
    expect(second.status).toBe(409);
    expect(second.body.error.details.refundablePaise).toBe(5000);
    expect((await refund(sub.id, { amountPaise: 5000 })).status).toBe(201);
    expect((await refund(sub.id, { amountPaise: 1 })).status).toBe(409);
    expect((await subOrderOf(sub.id)).refundedPaise).toBe(20000);
  });

  it('concurrent refunds cannot overshoot the cap (5 x 40% -> exactly 2 succeed)', async () => {
    const o = await paidOrder(app, ledger, { prices: [50000], quantities: [2] }); // 100000
    const results = await Promise.all(
      Array.from({ length: 5 }, () => refund(o.subs[0].id, { amountPaise: 40000 })),
    );
    const ok = results.filter((r) => r.status === 201);
    expect(ok.length).toBe(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    const sub = await subOrderOf(o.subs[0].id);
    expect(sub.refundedPaise).toBe(80000);
    expect(await Refund.countDocuments({ subOrderId: sub.id })).toBe(2);
    const reversed = (await Refund.find({ subOrderId: sub.id })).reduce(
      (n, r) => n + r.commissionReversedPaise,
      0,
    );
    expect(reversed).toBe(8000); // 10% of 80000
  });

  it('an Idempotency-Key makes a repeat answer 200 with the same refund and call the provider once', async () => {
    const o = await paidOrder(app, ledger);
    const first = await refund(o.subs[0].id, { amountPaise: 5000 }, 'key-aaaa-0001');
    const again = await refund(o.subs[0].id, { amountPaise: 5000 }, 'key-aaaa-0001');
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.data.refund.id).toBe(first.body.data.refund.id);
    expect(await Refund.countDocuments()).toBe(1);
    expect(calls('refundPayment')).toHaveLength(1);
    expect(calls('reverseTransfer')).toHaveLength(1);
    const other = await refund(o.subs[0].id, { amountPaise: 6000 }, 'key-aaaa-0001');
    expect(other.status).toBe(409);
    expect(other.body.error.details.reason).toBe('idempotency_key_reused');
  });

  it('the same key sent 5 times at once refunds once', async () => {
    const o = await paidOrder(app, ledger);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => refund(o.subs[0].id, { amountPaise: 5000 }, 'key-race-0001')),
    );
    expect(results.every((r) => [200, 201].includes(r.status))).toBe(true);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await Refund.countDocuments()).toBe(1);
    expect((await subOrderOf(o.subs[0].id)).refundedPaise).toBe(5000);
    expect(calls('refundPayment')).toHaveLength(1);
  });

  it('validates the body (422) and writes nothing', async () => {
    const o = await paidOrder(app, ledger);
    const id = o.subs[0].id;
    for (const body of [
      { reason: 'customer_cancel' },
      { note: '' },
      { amountPaise: 12.5 },
      { amountPaise: 0 },
      { amountPaise: -5 },
      { extra: 1 },
    ]) {
      expect((await refund(id, body)).status, JSON.stringify(body)).toBe(422);
    }
    expect(
      (
        await request(app)
          .post(`/api/v1/admin/sub-orders/${id}/refund`)
          .set(admin.auth)
          .send({ amountPaise: 5000 })
      ).status,
    ).toBe(422); // reason + note missing
    expect(
      (
        await request(app)
          .post(`/api/v1/admin/sub-orders/${id}/refund`)
          .set(admin.auth)
          .set('Idempotency-Key', 'x')
          .send({ reason: 'admin', note: 'abc' })
      ).status,
    ).toBe(422);
    expect(await Refund.countDocuments()).toBe(0);
    expect((await subOrderOf(id)).refundedPaise).toBe(0);
  });

  it('refuses a refund whose vendor share is below the provider minimum of INR 1.00 (422)', async () => {
    const o = await paidOrder(app, ledger, { prices: [10000], quantities: [2] });
    const res = await refund(o.subs[0].id, { amountPaise: 100 }); // 10 commission, 90 vendor share
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toBe('refund_below_minimum');
    expect((await subOrderOf(o.subs[0].id)).refundedPaise).toBe(0);
    expect(await Refund.countDocuments()).toBe(0);
  });

  it('404 for an unknown sub-order and for one that was never paid; 409 for a cancelled one', async () => {
    const o = await paidOrder(app, ledger);
    expect((await refund('a'.repeat(24), {})).status).toBe(404);

    const cancelled = await api(
      app,
      'post',
      `/orders/${o.orderId}/sub-orders/${o.subs[0].id}/cancel`,
      o.customer.auth,
      {},
    );
    expect(cancelled.status).toBe(200);
    const res = await refund(o.subs[0].id, { amountPaise: 1000 });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('not_refundable');

    await SubOrder.updateOne(
      { _id: o.subs[0].id },
      { $set: { statusHistory: [{ status: 'pending_payment', at: new Date() }] } },
    );
    expect((await refund(o.subs[0].id, {})).status).toBe(404); // never passed through `processing`
  });

  it('a customer or vendor token is refused (403)', async () => {
    const o = await paidOrder(app, ledger);
    for (const who of [o.customer, o.vendors[0]]) {
      const res = await request(app)
        .post(`/api/v1/admin/sub-orders/${o.subs[0].id}/refund`)
        .set(who.auth)
        .send({ reason: 'admin', note: 'abc' });
      expect(res.status).toBe(403);
    }
  });

  it('writes an audit entry (D30) for the refund', async () => {
    const o = await paidOrder(app, ledger);
    const res = await refund(o.subs[0].id, { amountPaise: 5000 });
    const entry = await AuditLog.findOne({ action: 'refund.created' });
    expect(entry.actorId.toString()).toBe(admin.id);
    expect(entry.entityId.toString()).toBe(o.subs[0].id);
    expect(entry.meta.refundId).toBe(res.body.data.refund.id);
  });
});

describe('refund timing rules', () => {
  it('a delivered sub-order is refundable inside the 7-day window and the settlement shrinks', async () => {
    const o = await paidOrder(app, ledger, { prices: [100000], quantities: [1] });
    await deliver(app, o.vendors[0], o.subs[0].id);
    const res = await refund(o.subs[0].id, { amountPaise: 50000 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await subOrderOf(o.subs[0].id)).fulfillmentStatus).toBe('delivered'); // admin refunds never change status
    const s = await settlementOf(o.subs[0].id);
    expect(s.status).toBe('pending_release');
    expect(s.netPayoutPaise).toBe(45000);
  });

  it('after the window it is 409 return_window_closed', async () => {
    const o = await paidOrder(app, ledger);
    await deliver(app, o.vendors[0], o.subs[0].id);
    await SubOrder.updateOne(
      { _id: o.subs[0].id },
      { returnWindowEndsAt: new Date(Date.now() - 1000) },
    );
    const res = await refund(o.subs[0].id, { amountPaise: 5000 });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('return_window_closed');
  });

  it('refunding an unshipped sub-order in full cancels it and restores the stock once', async () => {
    const o = await paidOrder(app, ledger, { quantities: [3] });
    const res = await refund(o.subs[0].id, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.subOrder).toMatchObject({
      fulfillmentStatus: 'cancelled',
      refundStatus: 'full',
    });
    expect((await Product.findById(o.products[0].id)).stockQty).toBe(20);
    expect((await subOrderOf(o.subs[0].id)).stockRestored).toBe(true);
    expect((await orderOf(o.orderId)).status).toBe('cancelled');
    expect((await settlementOf(o.subs[0].id)).status).toBe('reversed');
    expect((await refund(o.subs[0].id, {})).status).toBe(409); // cancelled: nothing more to refund
    expect((await Product.findById(o.products[0].id)).stockQty).toBe(20);
  });

  it('a partial refund of an unshipped sub-order leaves it processing and the stock alone', async () => {
    const o = await paidOrder(app, ledger, { quantities: [3] });
    await refund(o.subs[0].id, { amountPaise: 5000 });
    expect((await subOrderOf(o.subs[0].id)).fulfillmentStatus).toBe('processing');
    expect((await Product.findById(o.products[0].id)).stockQty).toBe(17);
  });

  it('after a partial refund a customer cancel refunds only the rest', async () => {
    const o = await paidOrder(app, ledger, { prices: [10000], quantities: [2] });
    await refund(o.subs[0].id, { amountPaise: 8000 });
    const res = await api(
      app,
      'post',
      `/orders/${o.orderId}/sub-orders/${o.subs[0].id}/cancel`,
      o.customer.auth,
      {},
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = await Refund.find({ subOrderId: o.subs[0].id }).sort({ createdAt: 1 });
    expect(rows.map((r) => r.amountPaise)).toEqual([8000, 12000]);
    expect(rows.reduce((n, r) => n + r.commissionReversedPaise, 0)).toBe(
      (await subOrderOf(o.subs[0].id)).commission.amountPaise,
    );
  });
});

describe('provider trouble', () => {
  it('a refund the provider refuses stays initiated; the retry does not reverse the transfer twice', async () => {
    const o = await paidOrder(app, ledger, { prices: [100000], quantities: [1] });
    ledger.failNext('refundPayment'); // the reversal succeeds, the customer refund fails
    const res = await refund(o.subs[0].id, { amountPaise: 50000 });
    expect(res.status).toBe(201);
    expect(res.body.data.refund.status).toBe('initiated');
    expect(res.body.data.subOrder.refundStatus).toBe('pending');
    const row = await Refund.findById(res.body.data.refund.id);
    expect(row.providerReversalId).toBeTruthy();
    expect(row.providerRefundId).toBeUndefined();

    const { refundsService } = app.get('phase6Services');
    // inside the 60 s claim window nobody else may call the provider
    expect(await refundsService.finish(row._id)).toBe('initiated');
    expect(calls('refundPayment')).toHaveLength(1);
    // later (the reconcile job's retry): finishes, and the reversal is not repeated
    expect(await refundsService.finish(row._id, { now: new Date(Date.now() + 6 * 60_000) })).toBe(
      'processed',
    );
    expect(calls('reverseTransfer')).toHaveLength(1);
    expect(calls('refundPayment')).toHaveLength(2);
    expect((await subOrderOf(o.subs[0].id)).refundStatus).toBe('partial');
  });

  it('two callers racing for the provider call: one asks the provider, the other leaves it', async () => {
    const o = await paidOrder(app, ledger, { prices: [100000], quantities: [1] });
    ledger.failNext('reverseTransfer');
    const res = await refund(o.subs[0].id, { amountPaise: 50000 });
    const id = res.body.data.refund.id;
    const { refundsService } = app.get('phase6Services');
    const later = new Date(Date.now() + 6 * 60_000);
    await Promise.all(Array.from({ length: 10 }, () => refundsService.finish(id, { now: later })));
    expect(calls('reverseTransfer')).toHaveLength(2); // the failed one + exactly one retry
    expect(calls('refundPayment')).toHaveLength(1);
    expect((await Refund.findById(id)).status).toBe('processed');
  });

  it('the reconcile job retries stuck refunds', async () => {
    const { createReconcilePendingJob } = await import('../src/jobs/reconcilePending.js');
    const { createJobLocks } = await import('../src/jobs/jobLock.js');
    const { silentLogger } = await import('./helpers.js');
    const o = await paidOrder(app, ledger);
    ledger.failNext('reverseTransfer');
    const res = await refund(o.subs[0].id, { amountPaise: 5000 });
    expect(res.body.data.refund.status).toBe('initiated');
    const job = createReconcilePendingJob({
      ...app.get('paymentServices'),
      refundsService: app.get('phase6Services').refundsService,
      jobLocks: createJobLocks(),
      logger: silentLogger,
      clock: () => new Date(Date.now() + 10 * 60_000),
    });
    await job.tick();
    expect((await Refund.findById(res.body.data.refund.id)).status).toBe('processed');
  });
});

describe('refund webhooks (A7: refund.processed / refund.failed)', () => {
  async function pendingRefund() {
    const o = await paidOrder(app, ledger, { prices: [100000], quantities: [1] });
    ledger.setNextRefundStatus('pending');
    const res = await refund(o.subs[0].id, { amountPaise: 50000 });
    ledger.setNextRefundStatus('processed');
    const row = await Refund.findById(res.body.data.refund.id);
    return { o, row };
  }

  it('a refund still pending at the provider stays initiated, then refund.processed completes it', async () => {
    const { o, row } = await pendingRefund();
    expect(row.status).toBe('initiated');
    expect(row.providerRefundId).toBeTruthy();
    expect((await subOrderOf(o.subs[0].id)).refundStatus).toBe('pending');

    ledger.setRefundStatus(row.providerRefundId, 'processed');
    const res = await webhook(
      ledger.buildRefundWebhook('refund.processed', { providerRefundId: row.providerRefundId }),
    );
    expect(res.status).toBe(200);
    expect((await Refund.findById(row._id)).status).toBe('processed');
    expect((await subOrderOf(o.subs[0].id)).refundStatus).toBe('partial');
  });

  it('the body is never trusted: a refund.processed event while the provider says pending changes nothing', async () => {
    const { row } = await pendingRefund();
    await webhook(
      ledger.buildRefundWebhook('refund.processed', { providerRefundId: row.providerRefundId }),
    );
    expect((await Refund.findById(row._id)).status).toBe('initiated');
  });

  it('refund.failed (confirmed by the provider) marks the refund failed and flags it', async () => {
    const { o, row } = await pendingRefund();
    ledger.setRefundStatus(row.providerRefundId, 'failed');
    await webhook(
      ledger.buildRefundWebhook('refund.failed', { providerRefundId: row.providerRefundId }),
    );
    expect((await Refund.findById(row._id)).status).toBe('failed');
    expect((await subOrderOf(o.subs[0].id)).refundStatus).toBe('failed');
  });

  it('a duplicate delivery or an unknown refund id is acknowledged (200) and changes nothing', async () => {
    const { row } = await pendingRefund();
    ledger.setRefundStatus(row.providerRefundId, 'processed');
    const hook = ledger.buildRefundWebhook('refund.processed', {
      providerRefundId: row.providerRefundId,
      eventId: 'evt-dup-1',
    });
    expect((await webhook(hook)).status).toBe(200);
    expect((await webhook(hook)).status).toBe(200);
    const unknown = ledger.buildRefundWebhook('refund.processed', {
      providerRefundId: 'rfnd_unknown',
    });
    expect((await webhook(unknown)).status).toBe(200);
    expect((await Refund.findById(row._id)).status).toBe('processed');
  });

  it('the reconcile job follows a refund whose webhook was lost', async () => {
    const { createReconcilePendingJob } = await import('../src/jobs/reconcilePending.js');
    const { createJobLocks } = await import('../src/jobs/jobLock.js');
    const { silentLogger } = await import('./helpers.js');
    const { row } = await pendingRefund();
    ledger.setRefundStatus(row.providerRefundId, 'processed');
    await createReconcilePendingJob({
      ...app.get('paymentServices'),
      refundsService: app.get('phase6Services').refundsService,
      jobLocks: createJobLocks(),
      logger: silentLogger,
      clock: () => new Date(Date.now() + 10 * 60_000),
    }).tick();
    expect((await Refund.findById(row._id)).status).toBe('processed');
  });
});

describe('Phase 5 late-capture refund and settlements', () => {
  it("a late capture refunded in full also ends the order's settlements (reversed, net 0)", async () => {
    const { vendors, category, customer } = await setupMarket(app, { vendors: 1 });
    const product = await addProduct(app, vendors[0], category, { stockQty: 2 });
    await fillCart(app, customer, [{ productId: product.id, quantity: 2 }]);
    const co = await checkout(app, customer);
    const providerOrderId = co.body.data.payment.providerOrderId;
    const { lifecycle } = app.get('paymentServices');
    await lifecycle.expireOrder(co.body.data.order.id);
    await Product.updateOne({ _id: product.id }, { stockQty: 0 }); // someone else bought it meanwhile
    const pay = ledger.simulatePayment(providerOrderId);
    const verified = await api(app, 'post', '/payments/verify', customer.auth, {
      orderId: co.body.data.order.id,
      razorpayOrderId: providerOrderId,
      razorpayPaymentId: pay.providerPaymentId,
      razorpaySignature: pay.signature,
    });
    expect(verified.body.data).toMatchObject({
      status: 'expired',
      paymentStatus: 'paid',
      refundStatus: 'full',
    });
    const s = await (
      await import('../src/modules/settlements/settlements.model.js')
    ).Settlement.findOne({});
    expect(s.status).toBe('reversed');
    expect(s.netPayoutPaise).toBe(0);
    const transfer = [...ledger.state.transfers.values()][0];
    expect(transfer.amountReversedPaise).toBe(transfer.amountPaise); // reverse_all took it back
    expect((await Order.findById(co.body.data.order.id)).refundStatus).toBe('full');
  });
});

// D57 (accepted 2026-11-03): the vendor is debited a share of the ACTUAL payout, so a platform-funded
// coupon's cost stays with the platform and a full refund leaves the vendor payout at zero.
describe('D57: refunds under a platform-funded coupon', () => {
  const coupon = {
    code: 'PLAT10',
    fundedBy: 'platform',
    scope: 'platform',
    type: 'percent',
    value: 10,
  };

  it('debits the proportional payout, not refund - commission; the last refund takes the remainder', async () => {
    // 2 x 100000 = 200000, platform coupon 10% -> customer pays 180000; commission 10% of the
    // base 200000 = 20000, vendor payout 180000.
    const o = await paidOrder(app, ledger, { prices: [100000], quantities: [2], coupon });
    const sub = o.subs[0];
    expect(sub).toMatchObject({ customerTotalPaise: 180000, vendorPayoutPaise: 180000 });
    expect(sub.commission.amountPaise).toBe(20000);

    const half = await refund(sub.id, { amountPaise: 90000 });
    expect(half.status, JSON.stringify(half.body)).toBe(201);
    // D9 commission reversal = 90000 x 20000 / 180000 = 10000; D57 vendor debit = 90000 x 180000 / 180000.
    // (The earlier D9-only rule would have debited 90000 - 10000 = 80000.)
    expect(half.body.data.refund).toMatchObject({
      commissionReversedPaise: 10000,
      vendorDebitPaise: 90000,
    });
    expect((await settlementOf(sub.id)).netPayoutPaise).toBe(90000);

    const rest = await refund(sub.id, {}); // everything still refundable
    expect(rest.status, JSON.stringify(rest.body)).toBe(201);
    expect(rest.body.data.refund).toMatchObject({
      amountPaise: 90000,
      commissionReversedPaise: 10000,
      vendorDebitPaise: 90000,
    });
    const s = await settlementOf(sub.id);
    expect(s).toMatchObject({ refundAdjustmentPaise: 180000, netPayoutPaise: 0 });
    // The provider transfer was reversed by the whole payout, in two reversals.
    expect(ledger.state.transfers.get(s.providerTransferId).amountReversedPaise).toBe(180000);
    expect((await subOrderOf(sub.id)).refundStatus).toBe('full');
  });
});
