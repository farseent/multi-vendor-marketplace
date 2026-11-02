import { mulDivRoundHalfUp } from './money.js';

/**
 * Commission maths (DECISIONS D6). Pure functions on integer paise: no database, no clock.
 */

/**
 * Which rate applies to one sub-order, and where it came from.
 *
 * D6 says "vendor override, then category default, then platform default" and snapshots ONE rate on
 * the sub-order. A sub-order can hold products from several categories, so a category default is
 * used only when every item resolves to the same one; if the categories disagree (or any item's
 * category has no default) the platform default applies. This tie-break is our reading of D6 and
 * is recorded as D52 so it can be reviewed.
 *
 * vendorBps: the vendor's `commissionRateBps` (null/undefined = no override)
 * categoryBps: one entry per item, each the category's `defaultCommissionBps` or null
 */
export function resolveCommissionRate({ vendorBps, categoryBps, platformBps }) {
  if (vendorBps !== null && vendorBps !== undefined) {
    return { rateBps: vendorBps, rateSource: 'vendor' };
  }
  const first = categoryBps[0];
  const sameCategoryRate =
    categoryBps.length > 0 &&
    first !== null &&
    first !== undefined &&
    categoryBps.every((bps) => bps === first);
  if (sameCategoryRate) return { rateBps: first, rateSource: 'category' };
  return { rateBps: platformBps, rateSource: 'platform' };
}

/**
 * Money for one sub-order.
 *
 * fundedBy 'vendor' (vendor coupons): base = subtotal - discount, so the vendor carries the
 *   discount. fundedBy 'platform' (admin coupons): the customer pays less but base = subtotal, so
 *   the vendor payout is unaffected and the platform absorbs the discount.
 * commission = roundHalfUp(base x rateBps / 10000); vendorPayout = base - commission, so
 * commission + vendorPayout == base always holds.
 */
export function computeSubOrderMoney({ subtotalPaise, discountPaise, fundedBy, rateBps }) {
  if (discountPaise > subtotalPaise) throw new RangeError('Discount exceeds the subtotal');
  const customerTotalPaise = subtotalPaise - discountPaise;
  const basePaise = fundedBy === 'platform' ? subtotalPaise : customerTotalPaise;
  const amountPaise = mulDivRoundHalfUp(basePaise, rateBps, 10_000);
  return {
    customerTotalPaise,
    basePaise,
    commissionPaise: amountPaise,
    vendorPayoutPaise: basePaise - amountPaise,
  };
}

/**
 * Settlement money for one sub-order at checkout (DATABASE_SCHEMA settlements): nothing has been
 * refunded yet, so net payout equals the vendor payout.
 */
export function initialSettlementMoney({ basePaise, commissionPaise }) {
  return {
    grossPaise: basePaise,
    commissionPaise,
    refundAdjustmentPaise: 0,
    netPayoutPaise: Math.max(0, basePaise - commissionPaise),
  };
}
