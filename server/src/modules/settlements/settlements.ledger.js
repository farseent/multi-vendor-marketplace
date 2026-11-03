import { Settlement } from './settlements.model.js';

/**
 * A full refund with `reverse_all` (the Phase 5 late capture) takes every vendor transfer of the
 * order back, so the order's settlements end here: reversed, nothing payable. Only settlements
 * that were not paid out yet are touched; the guard makes repeating it harmless.
 */
export async function reverseOrderSettlements(orderId) {
  const open = await Settlement.find({
    orderId,
    status: { $in: ['not_eligible', 'pending_release'] },
  });
  for (const s of open) {
    await Settlement.updateOne(
      { _id: s._id, status: s.status },
      {
        $set: {
          status: 'reversed',
          refundAdjustmentPaise: Math.max(0, s.grossPaise - s.commissionPaise),
          netPayoutPaise: 0,
        },
      },
    );
  }
  return open.length;
}
