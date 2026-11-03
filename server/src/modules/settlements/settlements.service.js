import mongoose from 'mongoose';
import { AppError } from '../../lib/AppError.js';
import { pageMeta, skipFor } from '../../lib/pagination.js';
import { SubOrder } from '../orders/orders.model.js';
import { Refund } from '../refunds/refunds.model.js';
import { Vendor } from '../shops/shops.model.js';
import { Settlement } from './settlements.model.js';
import { assertSettlementTransition } from './settlements.states.js';

const conflict = (reason, message) => new AppError('CONFLICT', 409, message, { reason });

/**
 * Vendor settlements: listing, the release of the provider hold, and following the provider
 * (ARCHITECTURE 3.5, DECISIONS D10, D45, D57).
 *
 * A settlement is only ever moved by a conditional update on its current status, so the hourly
 * job, the admin button and a webhook can all run at once and each move happens once.
 */
export function createSettlementsService({ paymentProvider, audit, logger }) {
  // Only settlements of orders that were really paid: an order that expired unpaid also has
  // (never payable) settlements, and nobody should see them. "Was paid" = the sub-order passed
  // through `processing`.
  const paidOnly = [
    {
      $lookup: {
        from: 'subOrders',
        localField: 'subOrderId',
        foreignField: '_id',
        as: 'sub',
      },
    },
    { $unwind: '$sub' },
    { $match: { 'sub.statusHistory.status': 'processing' } },
  ];

  const view = (s, { admin = false } = {}) => ({
    id: String(s._id),
    subOrderId: String(s.subOrderId),
    subOrderNumber: s.sub.subOrderNumber,
    grossPaise: s.grossPaise,
    commissionPaise: s.commissionPaise,
    refundAdjustmentPaise: s.refundAdjustmentPaise,
    netPayoutPaise: s.netPayoutPaise,
    status: s.status,
    eligibleAt: s.eligibleAt ?? null,
    releasedAt: s.releasedAt ?? null,
    settledAt: s.settledAt ?? null,
    createdAt: s.createdAt,
    ...(admin && {
      vendorId: String(s.vendorId),
      providerTransferId: s.providerTransferId ?? null,
      failureReason: s.failureReason ?? null,
    }),
  });

  async function list(match, { page, limit }, opts) {
    const [result] = await Settlement.aggregate([
      { $match: match },
      ...paidOnly,
      {
        $facet: {
          items: [
            { $sort: { createdAt: -1, _id: -1 } },
            { $skip: skipFor({ page, limit }) },
            { $limit: limit },
          ],
          total: [{ $count: 'n' }],
        },
      },
    ]);
    return {
      items: result.items.map((s) => view(s, opts)),
      meta: pageMeta({ page, limit }, result.total[0]?.n ?? 0),
    };
  }

  /** Why a pending settlement cannot be released right now, or null. */
  async function blocker(s, { now, respectWindow }) {
    if (s.status !== 'pending_release') return 'not_pending_release';
    const sub = await SubOrder.findById(s.subOrderId, 'returnWindowEndsAt');
    if (respectWindow && (!s.eligibleAt || s.eligibleAt > now || sub?.returnWindowEndsAt > now)) {
      return 'return_window_open';
    }
    if (await Refund.exists({ subOrderId: s.subOrderId, status: 'initiated' }))
      return 'open_refund';
    if (s.netPayoutPaise <= 0) return 'nothing_to_release';
    if (!s.providerTransferId) return 'no_provider_transfer';
    const vendor = await Vendor.findById(s.vendorId);
    const { active } = await paymentProvider.resolvePayoutAccount(vendor);
    return active ? null : 'payout_account_inactive';
  }

  /**
   * pending_release -> released, then asks the provider to take the hold off. The status flips
   * FIRST, guarded by the refund total we looked at, so a refund that lands in between makes the
   * claim fail instead of releasing money that is about to be reversed. If the provider call
   * fails the settlement goes back to pending_release and the next run tries again; a crash
   * between the two steps is what the reconciliation report is for. `respectWindow: false` is
   * the admin's manual release (demo/test).
   */
  async function release(settlementId, { now = new Date(), respectWindow = true } = {}) {
    const s = await Settlement.findById(settlementId);
    if (!s) throw new AppError('NOT_FOUND', 404, 'Settlement not found');
    const reason = await blocker(s, { now, respectWindow });
    if (reason) return { released: false, reason };

    assertSettlementTransition('pending_release', 'released');
    const claimed = await Settlement.findOneAndUpdate(
      { _id: s._id, status: 'pending_release', refundAdjustmentPaise: s.refundAdjustmentPaise },
      { $set: { status: 'released', releasedAt: now }, $unset: { failureReason: 1 } },
      { returnDocument: 'after' },
    );
    if (!claimed) return { released: false, reason: 'changed_meanwhile' };
    try {
      await paymentProvider.releaseTransfer(s.providerTransferId);
    } catch (err) {
      await Settlement.updateOne(
        { _id: s._id, status: 'released' },
        {
          $set: { status: 'pending_release', failureReason: 'release_failed' },
          $unset: { releasedAt: 1 },
        },
      );
      logger.warn(
        { err: err.message, settlementId: s.id },
        'Settlement release failed, will retry',
      );
      return { released: false, reason: 'provider_error', error: err };
    }
    logger.info(
      { settlementId: s.id, vendorId: String(s.vendorId), netPayoutPaise: s.netPayoutPaise },
      'settlement.released',
    );
    return { released: true, settlement: claimed };
  }

  /** The provider says what became of the transfer: failed, or paid out (settled). */
  async function syncFromProvider(s, { now = new Date() } = {}) {
    if (!s.providerTransferId || !['pending_release', 'released'].includes(s.status))
      return s.status;
    const transfer = await paymentProvider.fetchTransfer(s.providerTransferId);
    if (transfer.status === 'failed') {
      assertSettlementTransition(s.status, 'failed');
      await Settlement.updateOne(
        { _id: s._id, status: s.status },
        { $set: { status: 'failed', failureReason: 'transfer_failed' } },
      );
      logger.error({ settlementId: s.id }, 'settlement.transfer_failed');
      return 'failed';
    }
    if (s.status === 'released' && transfer.settlementStatus === 'settled') {
      assertSettlementTransition('released', 'settled');
      await Settlement.updateOne(
        { _id: s._id, status: 'released' },
        { $set: { status: 'settled', settledAt: now } },
      );
      logger.info({ settlementId: s.id }, 'settlement.settled');
      return 'settled';
    }
    return s.status;
  }

  return {
    release,
    syncFromProvider,

    listForVendor: (vendorId, query) =>
      list(
        {
          vendorId: new mongoose.Types.ObjectId(vendorId),
          ...(query.status && { status: query.status }),
        },
        query,
      ),
    listForAdmin: (query) =>
      list(
        {
          ...(query.vendorId && { vendorId: new mongoose.Types.ObjectId(query.vendorId) }),
          ...(query.status && { status: query.status }),
        },
        query,
        { admin: true },
      ),

    /** POST /admin/settlements/:id/release: manual, ignores the return window (demo/test). */
    async adminRelease(actor, settlementId) {
      const outcome = await release(settlementId, { respectWindow: false });
      if (!outcome.released) {
        if (outcome.reason === 'provider_error') throw outcome.error;
        if (outcome.reason === 'not_pending_release') {
          const s = await Settlement.findById(settlementId);
          assertSettlementTransition(s.status, 'released'); // always throws: a 409 naming the states
        }
        throw conflict(outcome.reason, `The settlement cannot be released: ${outcome.reason}`);
      }
      await audit.record(actor, {
        action: 'settlement.released',
        entityType: 'settlement',
        entityId: outcome.settlement._id,
        meta: { netPayoutPaise: outcome.settlement.netPayoutPaise, manual: true },
      });
      return outcome.settlement;
    },
  };
}
