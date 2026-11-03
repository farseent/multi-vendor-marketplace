import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { MIN_REVERSAL_PAISE, REFUND_CLAIM_MS, RETURN_WINDOW_DAYS } from '../../config/constants.js';
import { AppError } from '../../lib/AppError.js';
import {
  deriveOrderRefundStatus,
  deriveRefundStatus,
  netPayoutPaise,
  splitRefund,
} from '../../lib/refunds.js';
import { Order, SubOrder } from '../orders/orders.model.js';
import { Payment } from '../payments/payments.model.js';
import { Settlement } from '../settlements/settlements.model.js';
import { Refund } from './refunds.model.js';

const inTransaction = (work) => mongoose.connection.transaction(work);
const conflict = (reason, message, extra = {}) =>
  new AppError('CONFLICT', 409, message, { reason, ...extra });
const present = (r) => ({
  id: r.id,
  status: r.status,
  amountPaise: r.amountPaise,
  commissionReversedPaise: r.commissionReversedPaise,
  vendorDebitPaise: r.vendorDebitPaise,
});

/**
 * Refunds of a sub-order (DECISIONS D9, D57; ARCHITECTURE 3.4).
 *
 * Two phases, so a provider outage never loses a refund:
 *  1. `reserve` (inside the caller's transaction): atomically takes the amount from what is still
 *     refundable, splits it between commission and vendor (D9), writes the Refund (`initiated`) and
 *     moves the settlement. The cap `sum(refunds) <= customerTotalPaise` is one guarded $inc on the
 *     sub-order, so two racing refunds can never both fit.
 *  2. `finish` (after the commit): asks the provider, vendor transfer reversal first, then the
 *     customer refund, each step stored on the row so a retry never repeats a finished step.
 *     A refund the provider has not accepted stays `initiated`; the reconcile job retries it.
 */
export function createRefundsService({ paymentProvider, audit, logger }) {
  /** Recomputes sub-order and order refundStatus from the rows (D4). */
  async function refreshStatuses(subOrderId, { session } = {}) {
    const sub = await SubOrder.findById(subOrderId).session(session ?? null);
    const rows = await Refund.find({ subOrderId }, 'status').session(session ?? null);
    await SubOrder.updateOne(
      { _id: subOrderId },
      {
        $set: {
          refundStatus: deriveRefundStatus({
            statuses: rows.map((r) => r.status),
            refundedPaise: sub.refundedPaise,
            totalPaise: sub.customerTotalPaise,
          }),
        },
      },
      { session },
    );
    const siblings = await SubOrder.find(
      { orderId: sub.orderId },
      'refundedPaise customerTotalPaise',
    ).session(session ?? null);
    await Order.updateOne(
      { _id: sub.orderId },
      {
        $set: {
          refundStatus: deriveOrderRefundStatus({
            refundedPaise: siblings.reduce((n, s) => n + s.refundedPaise, 0),
            totalPaise: siblings.reduce((n, s) => n + s.customerTotalPaise, 0),
          }),
        },
      },
      { session },
    );
  }

  /**
   * Step 1. Must run inside `session`. Throws 409 when the amount does not fit, 422 when the
   * vendor's share is too small to reverse. Returns the Refund document.
   */
  async function reserve({
    session,
    subOrderId,
    amountPaise,
    reason,
    note,
    requestedBy,
    idempotencyKey,
  }) {
    const sub = await SubOrder.findOneAndUpdate(
      {
        _id: subOrderId,
        $expr: { $lte: [{ $add: ['$refundedPaise', amountPaise] }, '$customerTotalPaise'] },
      },
      { $inc: { refundedPaise: amountPaise } },
      { session, returnDocument: 'after' },
    );
    if (!sub) {
      const current = await SubOrder.findById(subOrderId).session(session);
      throw conflict('exceeds_refundable', 'The refund is more than the customer paid', {
        refundablePaise: current ? current.customerTotalPaise - current.refundedPaise : 0,
      });
    }
    // The $inc above locked the sub-order for this transaction, so these reads cannot go stale.
    const prior = await Refund.find(
      { subOrderId, status: { $in: ['initiated', 'processed'] } },
      'commissionReversedPaise',
    ).session(session);
    const split = splitRefund({
      refundPaise: amountPaise,
      totalPaise: sub.customerTotalPaise,
      commissionPaise: sub.commission.amountPaise,
      refundedBeforePaise: sub.refundedPaise - amountPaise,
      commissionReversedBeforePaise: prior.reduce((n, r) => n + r.commissionReversedPaise, 0),
    });
    if (split.vendorDebitPaise > 0 && split.vendorDebitPaise < MIN_REVERSAL_PAISE) {
      throw new AppError('VALIDATION_ERROR', 422, 'Invalid request', {
        reason: 'refund_below_minimum',
        message: 'The vendor share of this refund is below the provider minimum of INR 1.00',
      });
    }
    const payment = await Payment.findOne({ orderId: sub.orderId }).session(session);
    const [refund] = await Refund.create(
      [
        {
          paymentId: payment._id,
          orderId: sub.orderId,
          subOrderId: sub._id,
          amountPaise,
          ...split,
          reason,
          note,
          status: 'initiated',
          requestedBy,
          idempotencyKey,
        },
      ],
      { session },
    );

    const settlement = await Settlement.findOne({ subOrderId }).session(session);
    const refundAdjustmentPaise = settlement.refundAdjustmentPaise + split.vendorDebitPaise;
    const exhausted = sub.refundedPaise === sub.customerTotalPaise;
    await Settlement.updateOne(
      { _id: settlement._id },
      {
        $set: {
          refundAdjustmentPaise,
          netPayoutPaise: netPayoutPaise({ ...settlement.toObject(), refundAdjustmentPaise }),
          // Nothing left to pay out and nothing paid yet: the settlement ends here.
          ...(exhausted &&
            ['not_eligible', 'pending_release'].includes(settlement.status) && {
              status: 'reversed',
            }),
        },
      },
      { session },
    );
    await refreshStatuses(subOrderId, { session });
    return refund;
  }

  /** Marks a refund the provider confirmed, and settles the sub-order's statuses. */
  async function markProcessed(refundId) {
    await inTransaction(async (session) => {
      const refund = await Refund.findOneAndUpdate(
        { _id: refundId, status: 'initiated' },
        { $set: { status: 'processed' } },
        { session, returnDocument: 'after' },
      );
      if (refund?.subOrderId) await refreshStatuses(refund.subOrderId, { session });
    });
  }

  /** A refund the provider finally refused. The money already moved is NOT unwound (D57). */
  async function markFailed(refundId, reason) {
    await inTransaction(async (session) => {
      const refund = await Refund.findOneAndUpdate(
        { _id: refundId, status: 'initiated' },
        { $set: { status: 'failed' } },
        { session, returnDocument: 'after' },
      );
      if (refund?.subOrderId) await refreshStatuses(refund.subOrderId, { session });
    });
    logger.error({ refundId: String(refundId), reason }, 'refund.failed_needs_manual_action');
  }

  /**
   * Step 2. Safe to call from anywhere, any number of times: one caller at a time owns the
   * provider call (atomic claim, like D54) and finished steps are skipped. Returns the status.
   */
  async function finish(refundId, { now = new Date() } = {}) {
    const claimed = await Refund.findOneAndUpdate(
      {
        _id: refundId,
        status: 'initiated',
        subOrderId: { $exists: true },
        $or: [
          { providerCallAt: { $exists: false } },
          { providerCallAt: { $lt: new Date(now.getTime() - REFUND_CLAIM_MS) } },
        ],
      },
      { $set: { providerCallAt: now } },
      { returnDocument: 'after' },
    );
    if (!claimed) return (await Refund.findById(refundId))?.status ?? null;
    try {
      if (claimed.vendorDebitPaise > 0 && !claimed.providerReversalId) {
        const settlement = await Settlement.findOne({ subOrderId: claimed.subOrderId });
        if (!settlement?.providerTransferId) {
          throw new Error('The settlement has no provider transfer to reverse');
        }
        const { providerReversalId } = await paymentProvider.reverseTransfer({
          providerTransferId: settlement.providerTransferId,
          amountPaise: claimed.vendorDebitPaise,
          notes: { refundId: claimed.id, orderId: String(claimed.orderId) },
        });
        await Refund.updateOne({ _id: claimed._id }, { $set: { providerReversalId } });
      }
      if (!claimed.providerRefundId) {
        const payment = await Payment.findById(claimed.paymentId);
        const result = await paymentProvider.refundPayment({
          providerPaymentId: payment.providerPaymentId,
          amountPaise: claimed.amountPaise,
          reverseAll: false, // a partial refund of a multi-vendor payment cannot use it (D45)
          receipt: claimed.idempotencyKey,
        });
        await Refund.updateOne(
          { _id: claimed._id },
          { $set: { providerRefundId: result.providerRefundId } },
        );
        if (result.status === 'processed') await markProcessed(claimed._id);
      }
      logger.info({ refundId: claimed.id, subOrderId: String(claimed.subOrderId) }, 'refund.sent');
    } catch (err) {
      // Stays `initiated`, claim kept: the reconcile job retries after REFUND_RETRY_AFTER_MS.
      logger.warn(
        { err: err.message, refundId: claimed.id },
        'Refund not accepted yet, will retry',
      );
    }
    return (await Refund.findById(refundId))?.status ?? null;
  }

  /**
   * The provider says what became of a refund we sent (webhook, reconcile). The body of a webhook
   * never decides: this asks the provider. Late-capture refunds (no sub-order) only get their
   * status updated.
   */
  async function syncFromProvider(refund) {
    if (refund.status !== 'initiated' || !refund.providerRefundId) return refund.status;
    const payment = await Payment.findById(refund.paymentId);
    const remote = await paymentProvider.fetchRefund({
      providerPaymentId: payment.providerPaymentId,
      providerRefundId: refund.providerRefundId,
    });
    if (remote.status === 'processed') {
      await markProcessed(refund._id);
      return 'processed';
    }
    if (remote.status === 'failed') {
      await markFailed(refund._id, 'provider_refund_failed');
      return 'failed';
    }
    return 'initiated';
  }

  return {
    reserve,
    finish,
    syncFromProvider,
    refreshStatuses,
    present,

    /**
     * POST /admin/sub-orders/:id/refund (full or partial, inside the return window). `cancel`
     * is the fulfilment service's cancel-and-refund, used when the refund takes a sub-order that
     * has not shipped back to zero (the goods will not ship, so the stock goes back, once).
     */
    async adminRefund(
      actor,
      subOrderId,
      { amountPaise, note },
      { idempotencyKey, cancel, now = new Date() },
    ) {
      const sub = await SubOrder.findById(subOrderId);
      if (!sub || !sub.statusHistory.some((h) => h.status === 'processing')) {
        throw new AppError('NOT_FOUND', 404, 'Sub-order not found'); // never paid: nothing to refund
      }
      if (['pending_payment', 'cancelled'].includes(sub.fulfillmentStatus)) {
        throw conflict('not_refundable', 'This sub-order cannot be refunded');
      }
      if (sub.fulfillmentStatus === 'delivered' && now > sub.returnWindowEndsAt) {
        throw conflict(
          'return_window_closed',
          `The ${RETURN_WINDOW_DAYS}-day return window has ended`,
        );
      }
      const refundable = sub.customerTotalPaise - sub.refundedPaise;
      const amount = amountPaise ?? refundable;
      if (amount < 1 || amount > refundable) {
        throw conflict('exceeds_refundable', 'The refund is more than the customer paid', {
          refundablePaise: refundable,
        });
      }

      const key = `admin:${subOrderId}:${idempotencyKey ?? randomUUID()}`;
      const existing = await Refund.findOne({ idempotencyKey: key });
      const replay = async (refund) => {
        if (
          refund.subOrderId?.toString() !== subOrderId ||
          (amountPaise && refund.amountPaise !== amountPaise)
        ) {
          throw conflict(
            'idempotency_key_reused',
            'This Idempotency-Key was used for another refund',
          );
        }
        await finish(refund._id);
        return { replayed: true, refund: await Refund.findById(refund._id) };
      };
      if (existing) return replay(existing);

      try {
        let refund;
        if (sub.fulfillmentStatus === 'processing' && amount === refundable) {
          ({ refund } = await cancel({
            subOrderId,
            reason: 'admin',
            note,
            requestedBy: actor.id,
            idempotencyKey: key,
            actor,
          }));
        } else {
          refund = await inTransaction(async (session) => {
            const created = await reserve({
              session,
              subOrderId,
              amountPaise: amount,
              reason: 'admin',
              note,
              requestedBy: actor.id,
              idempotencyKey: key,
            });
            await audit.record(
              actor,
              {
                action: 'refund.created',
                entityType: 'subOrder',
                entityId: sub._id,
                meta: { refundId: created.id, amountPaise: amount },
              },
              { session },
            );
            return created;
          });
        }
        await finish(refund._id);
        return { replayed: false, refund: await Refund.findById(refund._id) };
      } catch (err) {
        if (err?.code === 11000) return replay(await Refund.findOne({ idempotencyKey: key })); // lost a race on the key
        throw err;
      }
    },
  };
}
