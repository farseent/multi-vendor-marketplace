import { mulDivRoundHalfUp } from './money.js';

/**
 * Refund maths (DECISIONS D9, D57). Pure functions on integer paise: no database, no clock.
 */

/**
 * How one refund splits between the platform's commission and the vendor.
 *
 * D9 (commission): commissionReversed = roundHalfUp(refund x commission / customerTotal); the
 * refund that exhausts the sub-order takes the REMAINDER (commission - already reversed), so the
 * reversals add up to the commission exactly.
 *
 * D57 (vendor): vendorDebit = roundHalfUp(refund x vendorPayout / customerTotal), calculated from
 * the vendor's ACTUAL payout, and the refund that exhausts the sub-order takes the remaining
 * payout. For vendor-funded coupons and plain orders this equals refund - commissionReversed. For
 * a platform-funded coupon (customer paid less than the base the payout was computed on) it does
 * not: a full refund still ends with the vendor payout at zero, and the platform bears the coupon.
 *
 *   refundPaise                 this refund
 *   totalPaise                  sub-order customerTotalPaise (what the customer paid for the slice)
 *   commissionPaise             sub-order commission.amountPaise
 *   vendorPayoutPaise           sub-order vendorPayoutPaise (base - commission)
 *   refundedBeforePaise         refunds already reserved or processed
 *   commissionReversedBeforePaise  commission already reversed by those
 *   vendorDebitBeforePaise      vendor payout already debited by those
 *
 * Clamps keep every number sane even for odd inputs: a reversal never exceeds what is left of the
 * commission or the refund itself, and a debit never exceeds what is left of the vendor payout.
 */
export function splitRefund({
  refundPaise,
  totalPaise,
  commissionPaise,
  vendorPayoutPaise,
  refundedBeforePaise,
  commissionReversedBeforePaise,
  vendorDebitBeforePaise,
}) {
  for (const n of [
    refundPaise,
    totalPaise,
    commissionPaise,
    vendorPayoutPaise,
    refundedBeforePaise,
    commissionReversedBeforePaise,
    vendorDebitBeforePaise,
  ]) {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('Expected non-negative integers');
  }
  if (refundPaise < 1) throw new RangeError('A refund must be at least 1 paise');
  if (totalPaise < 1) throw new RangeError('The sub-order total must be positive');
  if (refundedBeforePaise + refundPaise > totalPaise) {
    throw new RangeError('A refund cannot exceed the amount paid');
  }

  const exhausts = refundedBeforePaise + refundPaise === totalPaise;

  const commissionLeft = Math.max(0, commissionPaise - commissionReversedBeforePaise);
  const commissionProportional = mulDivRoundHalfUp(refundPaise, commissionPaise, totalPaise);
  const commissionReversedPaise = Math.min(
    exhausts ? commissionLeft : Math.min(commissionProportional, commissionLeft),
    refundPaise,
  );

  const payoutLeft = Math.max(0, vendorPayoutPaise - vendorDebitBeforePaise);
  const payoutProportional = mulDivRoundHalfUp(refundPaise, vendorPayoutPaise, totalPaise);
  const vendorDebitPaise = exhausts ? payoutLeft : Math.min(payoutProportional, payoutLeft);

  return { commissionReversedPaise, vendorDebitPaise };
}

/** netPayout = gross - commission - refundAdjustment, floor 0 (DATABASE_SCHEMA settlements). */
export const netPayoutPaise = ({ grossPaise, commissionPaise, refundAdjustmentPaise }) =>
  Math.max(0, grossPaise - commissionPaise - refundAdjustmentPaise);

/**
 * The sub-order's refundStatus (D4) from its refund rows' statuses and the amount refunded.
 * 'pending' while any refund still waits for the provider; 'failed' if one was refused for good.
 */
export function deriveRefundStatus({ statuses, refundedPaise, totalPaise }) {
  if (statuses.includes('initiated')) return 'pending';
  if (statuses.includes('failed')) return 'failed';
  if (refundedPaise <= 0) return 'none';
  return refundedPaise >= totalPaise ? 'full' : 'partial';
}

/** The order's aggregate refundStatus from its sub-orders' reserved or processed refunds. */
export function deriveOrderRefundStatus({ refundedPaise, totalPaise }) {
  if (refundedPaise <= 0) return 'none';
  return refundedPaise >= totalPaise ? 'full' : 'partial';
}
