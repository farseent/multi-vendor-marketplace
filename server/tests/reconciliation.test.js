import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createJobLocks } from '../src/jobs/jobLock.js';
import { createReconciliationJob } from '../src/jobs/reconciliation.js';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { Refund } from '../src/modules/refunds/refunds.model.js';
import { ReconciliationReport } from '../src/modules/settlements/reconciliation.model.js';
import { createMockLedger } from '../src/providers/payment/mockLedger.js';
import { clearDb, startTestDb, stopTestDb } from './db.js';
import { makeAdmin } from './factories.js';
import { buildTestApp, silentLogger } from './helpers.js';
import { api, addProduct, checkout, fillCart, makeCustomerDirect } from './phase5.helpers.js';
import { deliver, paidOrder, settlementOf } from './phase6.helpers.js';

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

const run = () => api(app, 'post', '/admin/reconciliation/run', admin.auth, {});
const transferOf = async (sub) =>
  ledger.state.transfers.get((await settlementOf(sub.id)).providerTransferId);

describe('POST /admin/reconciliation/run', () => {
  it('a clean run over three paid sub-orders reports ok and the totals', async () => {
    const o = await paidOrder(app, ledger, {
      vendorCount: 3,
      prices: [10000, 20000, 30000],
      quantities: [1, 1, 1],
    });
    await deliver(app, o.vendors[0], o.subs[0].id);
    const res = await run();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.mismatches).toEqual([]);
    expect(res.body.data.totals).toMatchObject({
      settlementsChecked: 3,
      skippedOpenRefund: 0,
      localNetPayoutPaise: 9000 + 18000 + 27000,
      providerRemainingPaise: 9000 + 18000 + 27000,
      mismatchCount: 0,
      truncated: false,
    });
    expect(await ReconciliationReport.countDocuments()).toBe(1);
  });

  it('ACCEPTANCE: one deliberately mismatched transfer is reported, and only that one', async () => {
    const o = await paidOrder(app, ledger, { vendorCount: 3 });
    // The provider quietly took 500 paise back from the second vendor's transfer.
    const t = await transferOf(o.subs[1]);
    ledger.tamperTransfer(t.id, { amountReversedPaise: 500 });

    const res = await run();
    expect(res.body.data.status).toBe('mismatch');
    expect(res.body.data.mismatches).toHaveLength(1);
    expect(res.body.data.mismatches[0]).toMatchObject({
      type: 'transfer_remaining_mismatch',
      entityType: 'settlement',
      settlementId: (await settlementOf(o.subs[1].id)).id,
      subOrderId: o.subs[1].id,
      providerTransferId: t.id,
      expected: 18000,
      actual: 17500,
    });
    expect(res.body.data.totals.mismatchCount).toBe(1);
    expect(res.body.data.totals.settlementsChecked).toBe(3);
  });

  const cases = [
    ['transfer_amount_mismatch', 'wrong amount at the provider', { amountPaise: 1 }],
    ['released_at_provider_early', 'hold taken off before we released it', { onHold: false }],
    ['transfer_failed', 'the provider failed the transfer', { status: 'failed' }],
  ];
  it.each(cases)('detects %s (%s)', async (type, _why, change) => {
    const o = await paidOrder(app, ledger);
    ledger.tamperTransfer((await transferOf(o.subs[0])).id, change);
    const res = await run();
    expect(res.body.data.mismatches.map((m) => m.type)).toContain(type);
    expect(res.body.data.status).toBe('mismatch');
  });

  it('detects a released settlement still on hold, and a settled one that is not', async () => {
    const o = await paidOrder(app, ledger, { vendorCount: 2 });
    for (let i = 0; i < 2; i++) await deliver(app, o.vendors[i], o.subs[i].id);
    const { Settlement } = await import('../src/modules/settlements/settlements.model.js');
    await Settlement.updateOne(
      { _id: (await settlementOf(o.subs[0].id)).id },
      { status: 'released' },
    ); // we think released; provider holds
    await Settlement.updateOne(
      { _id: (await settlementOf(o.subs[1].id)).id },
      { status: 'settled' },
    );
    ledger.tamperTransfer((await transferOf(o.subs[1])).id, {
      onHold: false,
      settlementStatus: 'pending',
    });
    const res = await run();
    expect(res.body.data.mismatches.map((m) => m.type).sort()).toEqual([
      'hold_not_released',
      'settlement_status_mismatch',
    ]);
  });

  it('detects a transfer the provider no longer knows', async () => {
    const o = await paidOrder(app, ledger);
    ledger.state.transfers.delete((await transferOf(o.subs[0])).id);
    const res = await run();
    expect(res.body.data.mismatches[0]).toMatchObject({
      type: 'transfer_unavailable',
      entityType: 'settlement',
    });
  });

  it('a refund done the right way is NOT a mismatch (reversal and our net agree)', async () => {
    const o = await paidOrder(app, ledger, { prices: [100000], quantities: [1] });
    const refund = await api(app, 'post', `/admin/sub-orders/${o.subs[0].id}/refund`, admin.auth, {
      reason: 'admin',
      note: 'Damaged',
      amountPaise: 40000,
    });
    expect(refund.status).toBe(201);
    const res = await run();
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.totals.localNetPayoutPaise).toBe(54000);
  });

  it('skips (and counts) settlements whose refund is still in flight', async () => {
    const o = await paidOrder(app, ledger, { prices: [100000], quantities: [1] });
    ledger.failNext('reverseTransfer');
    await api(app, 'post', `/admin/sub-orders/${o.subs[0].id}/refund`, admin.auth, {
      reason: 'admin',
      note: 'Damaged',
      amountPaise: 40000,
    });
    const res = await run();
    expect(res.body.data.totals.skippedOpenRefund).toBe(1);
    expect(res.body.data.mismatches).toEqual([]);
  });

  it('reports refunds stuck for over an hour and refunds that failed for good', async () => {
    const o = await paidOrder(app, ledger, { prices: [100000], quantities: [1] });
    ledger.failNext('reverseTransfer');
    const a = await api(app, 'post', `/admin/sub-orders/${o.subs[0].id}/refund`, admin.auth, {
      reason: 'admin',
      note: 'Damaged',
      amountPaise: 10000,
    });
    ledger.failNext('reverseTransfer');
    const b = await api(app, 'post', `/admin/sub-orders/${o.subs[0].id}/refund`, admin.auth, {
      reason: 'admin',
      note: 'Damaged',
      amountPaise: 11000,
    });
    // createdAt is immutable in Mongoose: age the row through the raw collection.
    await Refund.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(a.body.data.refund.id) },
      { $set: { createdAt: new Date(Date.now() - 2 * 3600_000) } },
    );
    await Refund.updateOne({ _id: b.body.data.refund.id }, { status: 'failed' });
    const res = await run();
    const types = res.body.data.mismatches.map((m) => `${m.entityType}:${m.type}`).sort();
    expect(types).toEqual(['refund:refund_failed', 'refund:refund_stuck']);
  });

  it('ignores the settlements of an order that was never paid', async () => {
    const o = await paidOrder(app, ledger);
    const other = await makeCustomerDirect('later@example.com');
    const product = await addProduct(app, o.vendors[0], { id: o.products[0].categoryId });
    await fillCart(app, other, [{ productId: product.id, quantity: 1 }]);
    expect((await checkout(app, other)).status).toBe(201); // unpaid
    const res = await run();
    expect(res.body.data.totals.settlementsChecked).toBe(1);
    expect(res.body.data.status).toBe('ok');
  });

  it('caps what it stores but counts every mismatch, and says when it was cut short', async () => {
    const o = await paidOrder(app, ledger, { vendorCount: 3 });
    for (const s of o.subs)
      ledger.tamperTransfer((await transferOf(s)).id, { amountReversedPaise: 100 });
    const { createReconciliationService } =
      await import('../src/modules/settlements/reconciliation.service.js');
    const small = createReconciliationService({
      paymentProvider: ledger,
      jobLocks: createJobLocks(),
      audit: { record: async () => {} },
      logger: silentLogger,
      config: {
        jobName: 'x',
        leaseMs: 1000,
        maxSettlements: 2,
        maxStoredMismatches: 1,
        stuckRefundAfterMs: 1e9,
      },
    });
    const report = await small.run({ trigger: 'job' });
    expect(report.totals).toMatchObject({
      truncated: true,
      settlementsChecked: 2,
      mismatchCount: 2,
    });
    expect(report.mismatches).toHaveLength(1);
  });

  it('is audited, and 409 while another run holds the lease', async () => {
    await paidOrder(app, ledger);
    const first = await run();
    const entry = await AuditLog.findOne({ action: 'reconciliation.run' });
    expect(entry.entityId.toString()).toBe(first.body.data.id);

    const { RECONCILIATION_JOB } = await import('../src/config/constants.js');
    const { jobLocks } = app.get('phase6Services');
    expect(await jobLocks.acquire(RECONCILIATION_JOB.jobName, 'the-daily-job', 60_000)).toBe(true);
    const busy = await run();
    expect(busy.status).toBe(409);
    expect(busy.body.error.details.reason).toBe('run_in_progress');
    await jobLocks.release(RECONCILIATION_JOB.jobName, 'the-daily-job');
    expect((await run()).status).toBe(201); // the lease is free again
  });

  it('customers and vendors are refused (403)', async () => {
    const o = await paidOrder(app, ledger);
    for (const who of [o.customer, o.vendors[0]]) {
      expect((await api(app, 'post', '/admin/reconciliation/run', who.auth, {})).status).toBe(403);
      expect((await api(app, 'get', '/admin/reconciliation', who.auth)).status).toBe(403);
    }
  });
});

describe('GET /admin/reconciliation', () => {
  it('lists reports newest first with paging', async () => {
    await paidOrder(app, ledger);
    const first = await run();
    const second = await run();
    const res = await api(app, 'get', '/admin/reconciliation?limit=1', admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(second.body.data.id);
    expect(res.body.meta).toMatchObject({ total: 2, limit: 1 });
    const page2 = await api(app, 'get', '/admin/reconciliation?limit=1&page=2', admin.auth);
    expect(page2.body.data[0].id).toBe(first.body.data.id);
  });
});

describe('daily reconciliation job', () => {
  const job = (offsetMs = 0) =>
    createReconciliationJob({
      reconciliationService: app.get('phase6Services').reconciliationService,
      jobLocks: createJobLocks(),
      logger: silentLogger,
      clock: () => new Date(Date.now() + offsetMs),
    });

  it('runs when there is no report, and not again within 23 hours', async () => {
    await paidOrder(app, ledger);
    expect(await job().tick()).toMatchObject({ status: 'ok' });
    expect(await job(3600_000).tick()).toMatchObject({ skipped: true });
    expect(await ReconciliationReport.countDocuments()).toBe(1);
    expect(await job(24 * 3600_000).tick()).toMatchObject({ status: 'ok' });
    expect(await ReconciliationReport.countDocuments()).toBe(2);
    expect((await ReconciliationReport.findOne().sort({ runAt: 1 })).trigger).toBe('job');
  });
});
