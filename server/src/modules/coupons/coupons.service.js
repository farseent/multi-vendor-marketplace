import { AppError } from '../../lib/AppError.js';
import { pageMeta, skipFor } from '../../lib/pagination.js';
import { Coupon } from './coupons.model.js';
import { couponRuleDetails, evaluateCoupon } from './coupons.rules.js';
import { CouponRedemption } from './redemptions.model.js';

const notFound = () => new AppError('NOT_FOUND', 404, 'Coupon not found');

/**
 * Coupon CRUD for vendors (their own, vendor-funded) and admins (platform-funded), plus
 * `evaluateForCart`, the lookup the cart uses. Ownership is part of every query (D15): another
 * vendor's coupon is a plain 404.
 */
export function createCouponsService({ audit }) {
  // Which coupons a caller may see: a vendor only its own, an admin only platform coupons.
  const vendorScope = (vendor) => ({ scope: 'vendor', vendorId: vendor.id });
  const platformScope = { scope: 'platform' };

  // Contract: vendor routes are for an approved shop ("V").
  function assertApproved(vendor) {
    if (vendor.status !== 'approved') {
      throw new AppError(
        'VENDOR_NOT_APPROVED',
        403,
        'Your shop must be approved before you can manage coupons',
      );
    }
  }

  function assertRules(candidate) {
    const details = couponRuleDetails(candidate);
    if (details.length) throw new AppError('VALIDATION_ERROR', 422, 'Invalid request', details);
  }

  async function list(scopeFilter, { status, page, limit }) {
    const filter = { ...scopeFilter, ...(status && { status }) };
    const [items, total] = await Promise.all([
      Coupon.find(filter).sort({ createdAt: -1 }).skip(skipFor({ page, limit })).limit(limit),
      Coupon.countDocuments(filter),
    ]);
    return { items: items.map((c) => c.toJSON()), meta: pageMeta({ page, limit }, total) };
  }

  async function load(scopeFilter, couponId) {
    const coupon = await Coupon.findOne({ _id: couponId, ...scopeFilter });
    if (!coupon) throw notFound();
    return coupon;
  }

  async function create(owner, data) {
    assertRules(data);
    const coupon = await Coupon.create({ ...data, ...owner }); // owner decides scope/fundedBy/vendorId
    return coupon;
  }

  async function update(coupon, patch) {
    // Check the combination that would result, not just the patch on its own.
    const next = {
      type: coupon.type,
      value: patch.value ?? coupon.value,
      maxDiscountPaise:
        patch.maxDiscountPaise === undefined ? coupon.maxDiscountPaise : patch.maxDiscountPaise,
      startsAt: patch.startsAt ?? coupon.startsAt,
      expiresAt: patch.expiresAt ?? coupon.expiresAt,
    };
    assertRules(next);
    for (const [field, value] of Object.entries(patch)) {
      coupon[field] = value ?? undefined; // null clears an optional field
    }
    await coupon.save(); // only the modified paths are written, so usedCount is never overwritten
    return coupon;
  }

  return {
    // --- vendor console ---
    async listForVendor(vendor, query) {
      assertApproved(vendor);
      return list(vendorScope(vendor), query);
    },
    async getForVendor(vendor, couponId) {
      assertApproved(vendor);
      return (await load(vendorScope(vendor), couponId)).toJSON();
    },
    async createForVendor(vendor, data) {
      assertApproved(vendor);
      const coupon = await create(
        { scope: 'vendor', fundedBy: 'vendor', vendorId: vendor.id },
        data,
      );
      return coupon.toJSON();
    },
    async updateForVendor(vendor, couponId, patch) {
      assertApproved(vendor);
      const coupon = await load(vendorScope(vendor), couponId);
      return (await update(coupon, patch)).toJSON();
    },

    // --- admin (platform coupons) ---
    listForAdmin: (query) => list(platformScope, query),
    async getForAdmin(couponId) {
      return (await load(platformScope, couponId)).toJSON();
    },
    async createForAdmin(actor, data) {
      const coupon = await create({ scope: 'platform', fundedBy: 'platform' }, data);
      await audit.record(actor, {
        action: 'coupon.created',
        entityType: 'coupon',
        entityId: coupon._id,
        meta: { code: coupon.code },
      });
      return coupon.toJSON();
    },
    async updateForAdmin(actor, couponId, patch) {
      const coupon = await update(await load(platformScope, couponId), patch);
      await audit.record(actor, {
        action: 'coupon.updated',
        entityType: 'coupon',
        entityId: coupon._id,
        meta: { code: coupon.code, fields: Object.keys(patch) },
      });
      return coupon.toJSON();
    },

    /**
     * Cart lookup. `lines` are the purchasable cart lines ({ vendorId, lineSubtotalPaise }).
     * Never throws for a bad coupon: returns { ok: false, reason } so the caller decides whether
     * that is a 422 (applying a code) or just a note in the cart preview (a saved code that
     * stopped being valid).
     */
    async evaluateForCart({ customerId, code, lines, now = new Date() }) {
      const coupon = await Coupon.findOne({ code });
      if (!coupon) return { ok: false, reason: 'not_found' };
      const usesByCustomer = await CouponRedemption.countDocuments({
        couponId: coupon._id,
        customerId,
        status: { $in: ['reserved', 'redeemed'] },
      });
      const result = evaluateCoupon(coupon, { lines, now, usesByCustomer });
      if (!result.ok) return result;
      return { ...result, coupon: { code: coupon.code, scope: coupon.scope, type: coupon.type } };
    },
  };
}
