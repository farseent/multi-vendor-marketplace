import { RECONCILE_JOB } from '../config/constants.js';
import { Order } from '../modules/orders/orders.model.js';
import { Payment } from '../modules/payments/payments.model.js';
import { Refund } from '../modules/refunds/refunds.model.js';
import { createLeasedJob } from './leasedJob.js';

// How long after expiry we keep asking the provider about an expired order (a lost webhook for a
// late payment). A known limit of the MVP, see HANDOVER.
const LATE_CAPTURE_WINDOW_MS = 60 * 60_000;

/**
 * Safety net for the two other confirmation paths (ARCHITECTURE 3.1 step 5c). Every minute it:
 *  1. asks the provider about `pending_payment` orders older than 5 minutes (browser closed, webhook
 *     lost) and confirms those that were paid;
 *  2. does the same for orders that expired in the last hour (a late payment whose webhook was lost);
 *  3. retries late-capture refunds the provider had not accepted yet.
 * One failing order never stops the rest.
 */
export function createReconcilePendingJob({
  paymentsService,
  jobLocks,
  logger,
  config = RECONCILE_JOB,
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
      const result = { checked: 0, confirmed: 0, refundsRetried: 0, errors: 0 };

      const pending = await Order.find({
        status: 'pending_payment',
        createdAt: { $lt: new Date(now.getTime() - config.minAgeMs) },
      })
        .sort({ createdAt: 1 })
        .limit(config.batchSize);
      const lateExpired = await Order.find({
        status: 'expired',
        paymentStatus: 'unpaid',
        updatedAt: { $gt: new Date(now.getTime() - LATE_CAPTURE_WINDOW_MS) },
      }).limit(config.batchSize);

      for (const order of [...pending, ...lateExpired]) {
        try {
          const payment = await Payment.findOne({ orderId: order._id });
          if (!payment?.providerOrderId) continue; // the provider order was never created
          result.checked += 1;
          const outcome = await paymentsService.confirmFromProvider(payment, 'reconcile');
          if (outcome !== 'none') result.confirmed += 1;
        } catch (err) {
          result.errors += 1;
          logger.warn(
            { err: err.message, orderId: order.id },
            'Reconcile could not check an order',
          );
        }
      }

      const staleClaim = new Date(now.getTime() - 60_000);
      const refunds = await Refund.find({
        reason: 'failed_late_capture',
        status: 'initiated',
        $or: [{ providerCallAt: { $exists: false } }, { providerCallAt: { $lt: staleClaim } }],
      }).limit(config.batchSize);
      for (const refund of refunds) {
        try {
          await paymentsService.finishRefund(refund.idempotencyKey);
          result.refundsRetried += 1;
        } catch (err) {
          result.errors += 1;
          logger.warn(
            { err: err.message, refundId: refund.id },
            'Reconcile could not retry a refund',
          );
        }
      }
      return result;
    },
  });
}
