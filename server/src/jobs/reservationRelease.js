import { RESERVATION_JOB } from '../config/constants.js';
import { Order } from '../modules/orders/orders.model.js';
import { Payment } from '../modules/payments/payments.model.js';
import { createLeasedJob } from './leasedJob.js';

/**
 * Expires unpaid orders whose reservation ran out and gives their stock and coupon back
 * (ARCHITECTURE 5). Runs every 60 s, so an order is released within 15-16 minutes of checkout.
 *
 * Before expiring an order it asks the provider whether the customer in fact paid (a lost webhook
 * and a closed browser tab look exactly like an unpaid order); if so the order is confirmed
 * instead. If the provider cannot be reached the order is expired anyway: a payment that turns up
 * later is handled by the late-capture path (re-reserve, or refund).
 */
export function createReservationReleaseJob({
  lifecycle,
  paymentsService,
  jobLocks,
  logger,
  config = RESERVATION_JOB,
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
      const due = await Order.find({
        status: 'pending_payment',
        reservationExpiresAt: { $lt: now },
      })
        .sort({ reservationExpiresAt: 1 })
        .limit(config.batchSize);

      const result = { expired: 0, confirmed: 0, skipped: 0 };
      for (const order of due) {
        try {
          const payment = await Payment.findOne({ orderId: order._id });
          if (payment?.providerOrderId) {
            const outcome = await paymentsService
              .confirmFromProvider(payment, 'reconcile')
              .catch((err) => {
                logger.warn(
                  { err: err.message, orderId: order.id },
                  'Could not check payment before expiry',
                );
                return 'none';
              });
            if (outcome !== 'none') {
              result.confirmed += 1;
              continue;
            }
          }
          const { expired } = await lifecycle.expireOrder(order._id, { now });
          if (expired) result.expired += 1;
          else result.skipped += 1; // paid or expired by someone else in the meantime
        } catch (err) {
          logger.error({ err, orderId: order.id }, 'Could not expire order');
        }
      }
      return result;
    },
  });
}
