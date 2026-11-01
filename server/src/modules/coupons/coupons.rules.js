import { COUPON } from '../../config/constants.js';
import { allocateProportionally, mulDivRoundHalfUp } from '../../lib/money.js';

/**
 * Pure coupon logic: no database, no clock of its own. That keeps it easy to table-test
 * (see tests/coupons.rules.test.js) and to reuse unchanged at checkout in Phase 5.
 */

/**
 * Field-combination rules for creating/editing a coupon. Returns [] when fine, otherwise
 * [{ path: 'body.value', message }] ready to send as a 422.
 * `c` needs: type, value, maxDiscountPaise?, startsAt, expiresAt.
 */
export function couponRuleDetails(c) {
  const details = [];
  const add = (field, message) => details.push({ path: `body.${field}`, message });

  if (c.type === 'percent' && !(c.value >= 1 && c.value <= COUPON.maxPercent)) {
    add('value', `A percent coupon must be between 1 and ${COUPON.maxPercent}`);
  }
  if (c.type === 'fixed' && c.value < COUPON.minFixedPaise) {
    add('value', `A fixed coupon must be at least ${COUPON.minFixedPaise} paise`);
  }
  if (c.maxDiscountPaise != null && c.type !== 'percent') {
    add('maxDiscountPaise', 'Only percent coupons can have a maximum discount');
  }
  if (!(c.expiresAt > c.startsAt)) add('expiresAt', 'Must be after startsAt');
  return details;
}

/**
 * Decides whether `coupon` can be applied to a cart and, if so, how much it takes off.
 *
 * lines:  the purchasable cart lines, [{ vendorId, lineSubtotalPaise }] (ids as strings)
 * now:    Date
 * usesByCustomer: how many reserved/redeemed uses this customer already has
 *
 * Returns { ok: false, reason } or { ok: true, discountPaise, lineDiscounts } where
 * lineDiscounts[i] is the share of the discount allocated to lines[i] (0 for lines the coupon
 * does not cover). The shares sum exactly to discountPaise (D6, largest remainder).
 */
export function evaluateCoupon(coupon, { lines, now, usesByCustomer }) {
  if (coupon.status !== 'active') return { ok: false, reason: 'disabled' };
  if (coupon.startsAt > now) return { ok: false, reason: 'not_started' };
  if (coupon.expiresAt <= now) return { ok: false, reason: 'expired' };

  // A vendor coupon only covers that vendor's lines; a platform coupon covers every line.
  const covered = lines.map(
    (line) => coupon.scope === 'platform' || line.vendorId === String(coupon.vendorId),
  );
  if (!covered.some(Boolean)) return { ok: false, reason: 'wrong_vendor' };

  const eligibleSubtotal = lines.reduce(
    (sum, line, i) => (covered[i] ? sum + line.lineSubtotalPaise : sum),
    0,
  );
  // The minimum is measured on the covered lines, so a vendor coupon's minimum is about that
  // vendor's items, not the whole basket.
  if (eligibleSubtotal < coupon.minOrderPaise) return { ok: false, reason: 'below_min_order' };

  if (coupon.usageLimitTotal != null && coupon.usedCount >= coupon.usageLimitTotal) {
    return { ok: false, reason: 'total_limit_reached' };
  }
  if (usesByCustomer >= coupon.usageLimitPerUser) {
    return { ok: false, reason: 'user_limit_reached' };
  }

  let discountPaise =
    coupon.type === 'percent'
      ? mulDivRoundHalfUp(eligibleSubtotal, coupon.value, 100)
      : coupon.value;
  if (coupon.maxDiscountPaise != null)
    discountPaise = Math.min(discountPaise, coupon.maxDiscountPaise);
  discountPaise = Math.min(discountPaise, eligibleSubtotal); // a fixed coupon never goes below zero

  // Spread over the covered lines in proportion to their subtotals; uncovered lines get 0.
  const coveredIdx = lines.map((_, i) => i).filter((i) => covered[i]);
  const shares = allocateProportionally(
    discountPaise,
    coveredIdx.map((i) => lines[i].lineSubtotalPaise),
  );
  const lineDiscounts = lines.map(() => 0);
  coveredIdx.forEach((lineIndex, k) => {
    lineDiscounts[lineIndex] = shares[k];
  });
  return { ok: true, discountPaise, lineDiscounts };
}
