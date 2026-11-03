import { RECONCILIATION_JOB } from '../../config/constants.js';
import { AppError } from '../../lib/AppError.js';
import { pageMeta, skipFor } from '../../lib/pagination.js';
import { Refund } from '../refunds/refunds.model.js';
import { ReconciliationReport } from './reconciliation.model.js';
import { Settlement } from './settlements.model.js';

/**
 * Reconciliation (ARCHITECTURE 3.5): compares what WE believe about every vendor transfer with
 * what the PROVIDER says, and writes a report. It only reads and reports; it never fixes.
 *
 * For each settlement of a paid order the provider transfer must have:
 *   - the amount we sent (gross - commission);
 *   - what is left after reversals equal to our net payout;
 *   - the hold we expect (held until released, free after);
 *   - the settlement state we recorded.
 * Settlements with a refund still in flight are skipped (their two sides legitimately differ for
 * a moment) and counted. Stuck and failed refunds are reported as well.
 */
export function createReconciliationService({
  paymentProvider,
  jobLocks,
  audit,
  logger,
  config = RECONCILIATION_JOB,
}) {
  async function compare(s, openRefundSubs, mismatches, totals) {
    const base = {
      entityType: 'settlement',
      settlementId: s._id,
      subOrderId: s.subOrderId,
      providerTransferId: s.providerTransferId,
    };
    let transfer;
    try {
      transfer = await paymentProvider.fetchTransfer(s.providerTransferId);
    } catch (err) {
      mismatches.push({ ...base, type: 'transfer_unavailable', detail: err.message });
      return;
    }
    totals.settlementsChecked += 1;
    totals.localNetPayoutPaise += s.netPayoutPaise;
    totals.providerRemainingPaise += transfer.amountPaise - transfer.amountReversedPaise;

    const found = (type, expected, actual) => mismatches.push({ ...base, type, expected, actual });
    const payout = s.grossPaise - s.commissionPaise;
    if (transfer.amountPaise !== payout)
      found('transfer_amount_mismatch', payout, transfer.amountPaise);
    if (transfer.status === 'failed' && s.status !== 'failed') {
      found('transfer_failed', s.status, transfer.status);
    }
    if (openRefundSubs.has(String(s.subOrderId))) {
      totals.skippedOpenRefund += 1;
      return;
    }
    const remaining = transfer.amountPaise - transfer.amountReversedPaise;
    if (remaining !== s.netPayoutPaise)
      found('transfer_remaining_mismatch', s.netPayoutPaise, remaining);
    if (['not_eligible', 'pending_release'].includes(s.status) && !transfer.onHold) {
      found('released_at_provider_early', 'on_hold', 'released');
    }
    if (['released', 'settled'].includes(s.status) && transfer.onHold) {
      found('hold_not_released', 'released', 'on_hold');
    }
    if (s.status === 'settled' && transfer.settlementStatus !== 'settled') {
      found('settlement_status_mismatch', 'settled', transfer.settlementStatus);
    }
    if (s.status === 'released' && transfer.settlementStatus === 'settled') {
      found('settled_not_recorded', 'released', 'settled');
    }
  }

  async function run({ trigger, triggeredBy, now = new Date() }) {
    const settlements = await Settlement.aggregate([
      { $match: { providerTransferId: { $exists: true } } },
      { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: 'order' } },
      { $match: { 'order.paymentStatus': 'paid' } },
      { $sort: { createdAt: 1, _id: 1 } },
      { $limit: config.maxSettlements + 1 },
    ]);
    const truncated = settlements.length > config.maxSettlements;
    const open = await Refund.find(
      { status: 'initiated', subOrderId: { $exists: true } },
      'subOrderId',
    );
    const openRefundSubs = new Set(open.map((r) => String(r.subOrderId)));

    const mismatches = [];
    const totals = {
      settlementsChecked: 0,
      skippedOpenRefund: 0,
      localNetPayoutPaise: 0,
      providerRemainingPaise: 0,
      truncated,
    };
    for (const s of settlements.slice(0, config.maxSettlements)) {
      await compare(s, openRefundSubs, mismatches, totals);
    }

    // Refunds that never completed: stuck (initiated for too long) or refused for good.
    const stuck = await Refund.find({
      status: 'initiated',
      createdAt: { $lt: new Date(now.getTime() - config.stuckRefundAfterMs) },
    });
    for (const r of stuck) {
      mismatches.push({
        entityType: 'refund',
        type: 'refund_stuck',
        refundId: r._id,
        subOrderId: r.subOrderId,
        detail: `initiated since ${r.createdAt.toISOString()}`,
      });
    }
    for (const r of await Refund.find({ status: 'failed' })) {
      mismatches.push({
        entityType: 'refund',
        type: 'refund_failed',
        refundId: r._id,
        subOrderId: r.subOrderId,
        detail: 'needs manual action',
      });
    }

    totals.mismatchCount = mismatches.length;
    const report = await ReconciliationReport.create({
      runAt: now,
      status: mismatches.length ? 'mismatch' : 'ok',
      trigger,
      triggeredBy,
      totals,
      mismatches: mismatches.slice(0, config.maxStoredMismatches),
    });
    logger.info(
      { reportId: report.id, status: report.status, mismatches: mismatches.length },
      'reconciliation.finished',
    );
    return report;
  }

  return {
    run,

    /** POST /admin/reconciliation/run. 409 while the daily job (or another run) holds the lease. */
    async runForAdmin(actor) {
      const owner = `admin:${actor.id}:${Date.now()}`;
      if (!(await jobLocks.acquire(config.jobName, owner, config.leaseMs))) {
        throw new AppError('CONFLICT', 409, 'A reconciliation run is already in progress', {
          reason: 'run_in_progress',
        });
      }
      try {
        const report = await run({ trigger: 'admin', triggeredBy: actor.id });
        await audit.record(actor, {
          action: 'reconciliation.run',
          entityType: 'reconciliationReport',
          entityId: report._id,
          meta: { status: report.status, mismatchCount: report.totals.mismatchCount },
        });
        return report;
      } finally {
        await jobLocks.release(config.jobName, owner);
      }
    },

    async list({ page, limit }) {
      const [items, total] = await Promise.all([
        ReconciliationReport.find().sort({ runAt: -1 }).skip(skipFor({ page, limit })).limit(limit),
        ReconciliationReport.countDocuments(),
      ]);
      return { items, meta: pageMeta({ page, limit }, total) };
    },
  };
}
