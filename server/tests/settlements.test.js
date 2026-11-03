import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createJobLocks } from '../src/jobs/jobLock.js';
import { createSettlementReleaseJob } from '../src/jobs/settlementRelease.js';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { Refund } from '../src/modules/refunds/refunds.model.js';
import { Settlement } from '../src/modules/settlements/settlements.model.js';
import { createMockLedger } from '../src/providers/payment/mockLedger.js';
import { clearDb, startTestDb, stopTestDb } from './db.js';
import { makeAdmin } from './factories.js';
import { buildTestApp, silentLogger } from './helpers.js';
import { api, addProduct, checkout, fillCart } from './phase5.helpers.js';
import { deliver, paidOrder, setStatus, settlementOf, TRACKING } from './phase6.helpers.js';

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

const DAY = 86_400_000;
const calls = (m) => ledger.state.calls.filter((c) => c.method === m);
const jobAt = (offsetMs) =>
  createSettlementReleaseJob({
    settlementsService: app.get('phase6Services').settlementsService,
    jobLocks: createJobLocks(),
    logger: silentLogger,
    clock: () => new Date(Date.now() + offsetMs),
  });
const webhook = (hook) =>
  request(app)
    .post('/api/v1/webhooks/razorpay')
    .set(hook.headers)
    .send(hook.rawBody.toString('utf8'));
const adminRefund = (subId, body) =>
  request(app)
    .post(`/api/v1/admin/sub-orders/${subId}/refund`)
    .set(admin.auth)
    .send({ reason: 'admin', note: 'Damaged', ...body });

describe('when a settlement becomes pending_release', () => {
  it('only on delivered: paid, shipped, cancelled and refunded keep it out', async () => {
    const o = await paidOrder(app, ledger, { vendorCount: 2 });
    expect((await settlementOf(o.subs[0].id)).status).toBe('not_eligible'); // paid
    await setStatus(app, o.vendors[0], o.subs[0].id, { status: 'shipped', tracking: TRACKING });
    expect((await settlementOf(o.subs[0].id)).status).toBe('not_eligible'); // shipped
    await setStatus(app, o.vendors[1], o.subs[1].id, { status: 'cancelled' });
    expect((await settlementOf(o.subs[1].id)).status).toBe('reversed'); // cancelled
    await setStatus(app, o.vendors[0], o.subs[0].id, { status: 'delivered' });
    const s = await settlementOf(o.subs[0].id);
    expect(s.status).toBe('pending_release');
    expect(s.eligibleAt).toBeInstanceOf(Date);
  });

  it('a sub-order refunded in full while shipped stays reversed when it is delivered', async () => {
    const o = await paidOrder(app, ledger);
    await setStatus(app, o.vendors[0], o.subs[0].id, { status: 'shipped', tracking: TRACKING });
    expect((await adminRefund(o.subs[0].id, {})).status).toBe(201);
    expect((await settlementOf(o.subs[0].id)).status).toBe('reversed');
    await setStatus(app, o.vendors[0], o.subs[0].id, { status: 'delivered' });
    expect((await settlementOf(o.subs[0].id)).status).toBe('reversed');
  });
});

describe('release job', () => {
  it('ignores a settlement whose return window has not elapsed', async () => {
    const o = await paidOrder(app, ledger);
    await deliver(app, o.vendors[0], o.subs[0].id);
    const result = await jobAt(3 * DAY).tick(); // day 3 of 7
    expect(result).toMatchObject({ released: 0 });
    expect((await settlementOf(o.subs[0].id)).status).toBe('pending_release');
    expect(calls('releaseTransfer')).toHaveLength(0);
  });

  it('releases it once the window has elapsed: provider hold taken off, state released', async () => {
    const o = await paidOrder(app, ledger);
    await deliver(app, o.vendors[0], o.subs[0].id);
    const s0 = await settlementOf(o.subs[0].id);
    expect(ledger.state.transfers.get(s0.providerTransferId).onHold).toBe(true);
    const result = await jobAt(8 * DAY).tick();
    expect(result).toMatchObject({ released: 1 });
    const s = await settlementOf(o.subs[0].id);
    expect(s.status).toBe('released');
    expect(s.releasedAt).toBeInstanceOf(Date);
    expect(ledger.state.transfers.get(s.providerTransferId).onHold).toBe(false);
  });

  it('is idempotent: running it again (or five times at once) releases once', async () => {
    const o = await paidOrder(app, ledger);
    await deliver(app, o.vendors[0], o.subs[0].id);
    const { settlementsService } = app.get('phase6Services');
    const s = await settlementOf(o.subs[0].id);
    const later = new Date(Date.now() + 8 * DAY);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => settlementsService.release(s._id, { now: later })),
    );
    expect(results.filter((r) => r.released)).toHaveLength(1);
    await jobAt(8 * DAY).tick();
    expect(calls('releaseTransfer')).toHaveLength(1);
  });

  it('ignores a settlement with an open refund, and releases it after the refund completes', async () => {
    const o = await paidOrder(app, ledger, { prices: [100000], quantities: [1] });
    await deliver(app, o.vendors[0], o.subs[0].id);
    ledger.setNextRefundStatus('pending');
    const res = await adminRefund(o.subs[0].id, { amountPaise: 50000 });
    ledger.setNextRefundStatus('processed');
    expect(res.body.data.refund.status).toBe('initiated');

    await jobAt(8 * DAY).tick();
    expect((await settlementOf(o.subs[0].id)).status).toBe('pending_release');
    expect(calls('releaseTransfer')).toHaveLength(0);

    const row = await Refund.findById(res.body.data.refund.id);
    ledger.setRefundStatus(row.providerRefundId, 'processed');
    await webhook(
      ledger.buildRefundWebhook('refund.processed', { providerRefundId: row.providerRefundId }),
    );
    await jobAt(8 * DAY).tick();
    const s = await settlementOf(o.subs[0].id);
    expect(s.status).toBe('released');
    // what the provider will pay out is exactly our net payout
    const t = ledger.state.transfers.get(s.providerTransferId);
    expect(t.amountPaise - t.amountReversedPaise).toBe(s.netPayoutPaise);
    expect(s.netPayoutPaise).toBe(45000);
  });

  it('skips a vendor whose payout account is not active', async () => {
    const o = await paidOrder(app, ledger);
    await deliver(app, o.vendors[0], o.subs[0].id);
    ledger.resolvePayoutAccount = async () => ({ linkedAccountId: null, active: false });
    await jobAt(8 * DAY).tick();
    expect((await settlementOf(o.subs[0].id)).status).toBe('pending_release');
    expect(calls('releaseTransfer')).toHaveLength(0);
  });

  it('a provider failure leaves it pending_release for the next run', async () => {
    const o = await paidOrder(app, ledger);
    await deliver(app, o.vendors[0], o.subs[0].id);
    ledger.failNext('releaseTransfer');
    await jobAt(8 * DAY).tick();
    const failed = await settlementOf(o.subs[0].id);
    expect(failed.status).toBe('pending_release');
    expect(failed.failureReason).toBe('release_failed');
    expect(failed.releasedAt).toBeUndefined();
    await jobAt(8 * DAY).tick();
    const s = await settlementOf(o.subs[0].id);
    expect(s.status).toBe('released');
    expect(s.failureReason).toBeUndefined();
  });

  it('never touches settlements that are not pending_release', async () => {
    const o = await paidOrder(app, ledger);
    await jobAt(30 * DAY).tick(); // paid, not delivered
    expect(calls('releaseTransfer')).toHaveLength(0);
    expect((await settlementOf(o.subs[0].id)).status).toBe('not_eligible');
  });
});

describe('following the provider: settled and failed', () => {
  async function releasedSettlement() {
    const o = await paidOrder(app, ledger);
    await deliver(app, o.vendors[0], o.subs[0].id);
    await jobAt(8 * DAY).tick();
    return { o, s: await settlementOf(o.subs[0].id) };
  }

  it('the sweep marks a released settlement settled once Razorpay paid it out', async () => {
    const { s } = await releasedSettlement();
    await jobAt(8 * DAY + 2 * 3600_000).tick();
    expect((await Settlement.findById(s._id)).status).toBe('released'); // not paid out yet
    ledger.settleTransfer(s.providerTransferId);
    await jobAt(8 * DAY + 2 * 3600_000).tick();
    const done = await Settlement.findById(s._id);
    expect(done.status).toBe('settled');
    expect(done.settledAt).toBeInstanceOf(Date);
  });

  it('transfer.processed (confirmed by a provider fetch) settles it', async () => {
    const { s } = await releasedSettlement();
    ledger.settleTransfer(s.providerTransferId);
    expect(
      (
        await webhook(
          ledger.buildTransferWebhook('transfer.processed', {
            providerTransferId: s.providerTransferId,
          }),
        )
      ).status,
    ).toBe(200);
    expect((await Settlement.findById(s._id)).status).toBe('settled');
  });

  it('the body is not trusted: transfer.processed while the provider has not settled changes nothing', async () => {
    const { s } = await releasedSettlement();
    await webhook(
      ledger.buildTransferWebhook('transfer.processed', {
        providerTransferId: s.providerTransferId,
      }),
    );
    expect((await Settlement.findById(s._id)).status).toBe('released');
  });

  it('transfer.failed marks the settlement failed with a reason', async () => {
    const { s } = await releasedSettlement();
    ledger.failTransfer(s.providerTransferId);
    await webhook(
      ledger.buildTransferWebhook('transfer.failed', { providerTransferId: s.providerTransferId }),
    );
    const failed = await Settlement.findById(s._id);
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('transfer_failed');
  });

  it('settlement.processed and unknown transfers are acknowledged and ignored', async () => {
    const { s } = await releasedSettlement();
    ledger.settleTransfer(s.providerTransferId);
    const hook = ledger.buildTransferWebhook('settlement.processed', {
      providerTransferId: s.providerTransferId,
    });
    expect((await webhook(hook)).status).toBe(200);
    expect(
      (
        await webhook(
          ledger.buildTransferWebhook('transfer.processed', { providerTransferId: 'trf_unknown' }),
        )
      ).status,
    ).toBe(200);
    expect((await Settlement.findById(s._id)).status).toBe('released'); // settlement.processed is not acted on
  });
});

describe('GET /vendor/settlements', () => {
  it('shows a vendor only their own settlements, with the money fields and no provider ids', async () => {
    const o = await paidOrder(app, ledger, {
      vendorCount: 2,
      prices: [10000, 20000],
      quantities: [2, 1],
    });
    const a = await api(app, 'get', '/vendor/settlements', o.vendors[0].auth);
    expect(a.status).toBe(200);
    expect(a.body.data).toHaveLength(1);
    expect(a.body.meta).toMatchObject({ page: 1, total: 1 });
    expect(a.body.data[0]).toMatchObject({
      subOrderId: o.subs[0].id,
      grossPaise: 20000,
      commissionPaise: 2000,
      refundAdjustmentPaise: 0,
      netPayoutPaise: 18000,
      status: 'not_eligible',
    });
    expect(JSON.stringify(a.body)).not.toMatch(/providerTransferId|vendorId/);
    const b = await api(app, 'get', '/vendor/settlements', o.vendors[1].auth);
    expect(b.body.data[0].netPayoutPaise).toBe(18000);
    expect(b.body.data[0].subOrderId).toBe(o.subs[1].id);
  });

  it('filters by status and hides the settlements of an order that was never paid', async () => {
    const o = await paidOrder(app, ledger);
    // a second order from the same vendor that the customer never pays
    const product = await addProduct(app, o.vendors[0], { id: o.products[0].categoryId });
    await fillCart(app, o.customer, [{ productId: product.id, quantity: 1 }]);
    expect((await checkout(app, o.customer)).status).toBe(201);
    expect(await Settlement.countDocuments()).toBe(2);

    const all = await api(app, 'get', '/vendor/settlements', o.vendors[0].auth);
    expect(all.body.data).toHaveLength(1); // the unpaid one is invisible
    expect(
      (await api(app, 'get', '/vendor/settlements?status=pending_release', o.vendors[0].auth)).body
        .data,
    ).toHaveLength(0);
    expect(
      (await api(app, 'get', '/vendor/settlements?status=bogus', o.vendors[0].auth)).status,
    ).toBe(422);
  });

  it('shows the effect of a refund and of a full reversal', async () => {
    const o = await paidOrder(app, ledger, { prices: [100000], quantities: [1] });
    await adminRefund(o.subs[0].id, { amountPaise: 50000 });
    let row = (await api(app, 'get', '/vendor/settlements', o.vendors[0].auth)).body.data[0];
    expect(row).toMatchObject({
      refundAdjustmentPaise: 45000,
      netPayoutPaise: 45000,
      status: 'not_eligible',
    });
    await adminRefund(o.subs[0].id, {});
    row = (await api(app, 'get', '/vendor/settlements', o.vendors[0].auth)).body.data[0];
    expect(row).toMatchObject({ netPayoutPaise: 0, status: 'reversed' });
  });
});

describe('admin settlements', () => {
  it('lists every vendor with provider details, filterable by status and vendor', async () => {
    const o = await paidOrder(app, ledger, { vendorCount: 2 });
    await deliver(app, o.vendors[0], o.subs[0].id);
    const all = await api(app, 'get', '/admin/settlements', admin.auth);
    expect(all.body.data).toHaveLength(2);
    expect(all.body.data[0].providerTransferId).toBeTruthy();
    const pending = await api(app, 'get', '/admin/settlements?status=pending_release', admin.auth);
    expect(pending.body.data.map((s) => s.subOrderId)).toEqual([o.subs[0].id]);
    const byVendor = await api(
      app,
      'get',
      `/admin/settlements?vendorId=${o.vendors[1].shop.id}`,
      admin.auth,
    );
    expect(byVendor.body.data.map((s) => s.subOrderId)).toEqual([o.subs[1].id]);
  });

  it('manual release ignores the return window, is audited, and a second call is 409', async () => {
    const o = await paidOrder(app, ledger);
    await deliver(app, o.vendors[0], o.subs[0].id);
    const s = await settlementOf(o.subs[0].id);
    const res = await api(app, 'post', `/admin/settlements/${s.id}/release`, admin.auth, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ id: s.id, status: 'released' });
    expect(ledger.state.transfers.get(s.providerTransferId).onHold).toBe(false);
    const audit = await AuditLog.findOne({ action: 'settlement.released' });
    expect(audit.entityId.toString()).toBe(s.id);
    const again = await api(app, 'post', `/admin/settlements/${s.id}/release`, admin.auth, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(calls('releaseTransfer')).toHaveLength(1);
  });

  it('manual release of a settlement that was not delivered, or has an open refund, is 409', async () => {
    const o = await paidOrder(app, ledger, { prices: [100000], quantities: [1] });
    const s = await settlementOf(o.subs[0].id);
    const early = await api(app, 'post', `/admin/settlements/${s.id}/release`, admin.auth, {});
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('INVALID_STATE_TRANSITION');

    await deliver(app, o.vendors[0], o.subs[0].id);
    ledger.setNextRefundStatus('pending');
    await adminRefund(o.subs[0].id, { amountPaise: 50000 });
    const open = await api(app, 'post', `/admin/settlements/${s.id}/release`, admin.auth, {});
    expect(open.status).toBe(409);
    expect(open.body.error.details.reason).toBe('open_refund');
    expect((await settlementOf(o.subs[0].id)).status).toBe('pending_release');
  });

  it('a provider error on manual release is a 502 and the settlement stays pending', async () => {
    const o = await paidOrder(app, ledger);
    await deliver(app, o.vendors[0], o.subs[0].id);
    const s = await settlementOf(o.subs[0].id);
    ledger.failNext('releaseTransfer');
    const res = await api(app, 'post', `/admin/settlements/${s.id}/release`, admin.auth, {});
    expect(res.status).toBe(502);
    expect((await settlementOf(o.subs[0].id)).status).toBe('pending_release');
  });

  it('404 for an unknown settlement; customers and vendors are refused (403)', async () => {
    const o = await paidOrder(app, ledger);
    expect(
      (await api(app, 'post', `/admin/settlements/${'a'.repeat(24)}/release`, admin.auth, {}))
        .status,
    ).toBe(404);
    for (const who of [o.customer, o.vendors[0]]) {
      expect((await api(app, 'get', '/admin/settlements', who.auth)).status).toBe(403);
    }
  });
});
