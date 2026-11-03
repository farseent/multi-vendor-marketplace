import { WEBHOOK_STALE_CLAIM_MS } from '../../config/constants.js';
import { Refund } from '../refunds/refunds.model.js';
import { Settlement } from '../settlements/settlements.model.js';
import { Payment, WebhookEvent } from './payments.model.js';

// Events Phase 5 acts on (D46). Everything else is stored as `ignored`.
const PAID_EVENTS = new Set(['payment.captured', 'order.paid']);
// Phase 6 (D57). Refund events are official (A7, closed); `settlement.processed` names a
// settlement, not a transfer, so it is acknowledged but not acted on (settled comes from the
// transfer fetch, see settlementRelease job).
const REFUND_EVENTS = new Set(['refund.processed', 'refund.failed']);
const TRANSFER_EVENTS = new Set(['transfer.processed', 'transfer.failed']);

/**
 * Webhook processing (ARCHITECTURE 3.2, DECISIONS D46). The controller has already verified the
 * signature; this service deduplicates, claims and processes.
 *
 * Claiming is a single-document atomic update, so when Razorpay retries or two instances receive
 * the same event at once, exactly one of them processes it.
 */
export function createWebhooksService({
  provider,
  paymentProvider,
  paymentsService,
  refundsService = null,
  settlementsService = null,
  logger,
  staleClaimMs = WEBHOOK_STALE_CLAIM_MS,
}) {
  /**
   * True if THIS request now owns the event. A first delivery inserts the row; a duplicate may
   * take over a `failed` row, or a `received` row whose owner went silent (crashed) for longer
   * than the stale window. Everything else belongs to someone else or is finished.
   */
  async function claim(eventId, eventType) {
    try {
      await WebhookEvent.create({ provider, eventId, eventType });
      return true;
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
    const staleBefore = new Date(Date.now() - staleClaimMs);
    const taken = await WebhookEvent.findOneAndUpdate(
      {
        provider,
        eventId,
        $or: [{ status: 'failed' }, { status: 'received', claimedAt: { $lt: staleBefore } }],
      },
      { $set: { status: 'received', claimedAt: new Date() }, $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    );
    return Boolean(taken);
  }

  const finish = (eventId, status, error) =>
    WebhookEvent.updateOne(
      { provider, eventId },
      { $set: { status, processedAt: new Date(), ...(error && { error }) } },
    );

  async function process(eventType, body) {
    const entity = body?.payload?.payment?.entity;
    const providerOrderId = entity?.order_id;

    if (eventType === 'payment.failed') {
      if (!providerOrderId) return { status: 'ignored', error: 'no_order_id' };
      // Only moves status forward: a payment that is already authorized/captured is left alone.
      await Payment.updateOne(
        { providerOrderId, status: 'created' },
        {
          $set: {
            status: 'failed',
            failureReason: String(entity?.error_description ?? 'payment_failed').slice(0, 200),
          },
        },
      );
      return { status: 'processed' };
    }

    // The body only says WHICH refund or transfer; what happened is asked of the provider (D46).
    if (REFUND_EVENTS.has(eventType) && refundsService) {
      const providerRefundId = body?.payload?.refund?.entity?.id;
      if (!providerRefundId) return { status: 'ignored', error: 'no_refund_id' };
      const refund = await Refund.findOne({ providerRefundId });
      // Not recorded yet (the event beat our own write): the reconcile job looks it up later.
      if (!refund) return { status: 'ignored', error: 'unknown_refund' };
      return { status: 'processed', outcome: await refundsService.syncFromProvider(refund) };
    }
    if (TRANSFER_EVENTS.has(eventType) && settlementsService) {
      const providerTransferId = body?.payload?.transfer?.entity?.id;
      if (!providerTransferId) return { status: 'ignored', error: 'no_transfer_id' };
      const settlement = await Settlement.findOne({ providerTransferId });
      if (!settlement) return { status: 'ignored', error: 'unknown_transfer' };
      return {
        status: 'processed',
        outcome: await settlementsService.syncFromProvider(settlement),
      };
    }

    if (!PAID_EVENTS.has(eventType)) return { status: 'ignored' };
    if (!providerOrderId || !entity?.id) return { status: 'ignored', error: 'no_payment_in_event' };
    const payment = await Payment.findOne({ providerOrderId });
    if (!payment) return { status: 'ignored', error: 'unknown_order' };

    // The body is never trusted for payment state: ask the provider (ARCHITECTURE 3.2).
    const providerPayment = await paymentProvider.fetchPayment(entity.id);
    const outcome = await paymentsService.markOrderPaid({
      payment,
      providerPayment,
      via: 'webhook',
    });
    return { status: 'processed', outcome };
  }

  return {
    /** Returns { duplicate: boolean }. Never throws for a processing failure (the answer is 200). */
    async receive({ eventId, eventType, body }) {
      if (!(await claim(eventId, eventType))) return { duplicate: true };
      try {
        const result = await process(eventType, body);
        await finish(eventId, result.status, result.error);
        return { duplicate: false, ...result };
      } catch (err) {
        // `failed` rows are recovered by a redelivery of the same event (claim above) and by the
        // reconcile job, which asks the provider directly.
        logger.error({ err: err.message, eventId, eventType }, 'Webhook processing failed');
        await finish(eventId, 'failed', String(err.message).slice(0, 300)).catch(() => {});
        return { duplicate: false, status: 'failed' };
      }
    },
  };
}
