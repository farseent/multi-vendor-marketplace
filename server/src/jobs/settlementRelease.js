import { SETTLEMENT_JOB } from '../config/constants.js';
import { Settlement } from '../modules/settlements/settlements.model.js';
import { createLeasedJob } from './leasedJob.js';

/**
 * Hourly (ARCHITECTURE 3.5). Two passes:
 *  1. releases settlements that are `pending_release`, whose return window has ended (the service
 *     skips any with an open refund, an inactive payout account, or nothing left to pay);
 *  2. follows the provider for settlements already `released`: when Razorpay has paid the transfer
 *     out they become `settled`; a failed transfer becomes `failed`. This is what covers a lost
 *     `transfer.processed` webhook.
 * One failing settlement never stops the rest.
 */
export function createSettlementReleaseJob({
  settlementsService,
  jobLocks,
  logger,
  config = SETTLEMENT_JOB,
  clock = () => new Date(),
}) {
  return createLeasedJob({
    name: config.jobName,
    intervalMs: config.intervalMs,
    leaseMs: config.leaseMs,
    jobLocks,
    logger,
    async run() {
      const now = clock();
      const result = { released: 0, skipped: 0, settled: 0, failed: 0, errors: 0 };

      const due = await Settlement.find({ status: 'pending_release', eligibleAt: { $lte: now } })
        .sort({ eligibleAt: 1 })
        .limit(config.batchSize);
      for (const s of due) {
        try {
          const outcome = await settlementsService.release(s._id, { now, respectWindow: true });
          if (outcome.released) result.released += 1;
          else result.skipped += 1;
        } catch (err) {
          result.errors += 1;
          logger.error({ err, settlementId: s.id }, 'Settlement release crashed');
        }
      }

      const released = await Settlement.find({
        status: 'released',
        releasedAt: { $lt: new Date(now.getTime() - config.settleCheckAfterMs) },
      }).limit(config.batchSize);
      for (const s of released) {
        try {
          const status = await settlementsService.syncFromProvider(s, { now });
          if (status === 'settled') result.settled += 1;
          if (status === 'failed') result.failed += 1;
        } catch (err) {
          result.errors += 1;
          logger.warn(
            { err: err.message, settlementId: s.id },
            'Could not follow a released settlement',
          );
        }
      }
      return result;
    },
  });
}
