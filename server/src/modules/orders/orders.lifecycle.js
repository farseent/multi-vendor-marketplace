import mongoose from 'mongoose';
import { CACHE } from '../../config/constants.js';
import { Product } from '../catalog/products.model.js';
import { Coupon } from '../coupons/coupons.model.js';
import { CouponRedemption } from '../coupons/redemptions.model.js';
import { Order, SubOrder } from './orders.model.js';

const inTransaction = (work) => mongoose.connection.transaction(work);

/**
 * State changes of an order that more than one caller needs: expiry (the reservation job and the
 * checkout compensation) and stock/coupon release. Every change is guarded by a status or a flag,
 * so running it twice, or from two instances at once, restores stock and the coupon exactly once
 * (ARCHITECTURE 5).
 */
export function createOrderLifecycle({ searchOutbox, cache, logger }) {
  async function invalidateProducts(slugs) {
    if (slugs.length === 0) return;
    await cache.del(...slugs.map((slug) => CACHE.keys.product(slug)));
  }

  /**
   * Puts an order's items back on the shelf inside `session`. Returns the products that went from
   * 0 to in-stock (their search entry and cached page must be refreshed).
   */
  async function restoreStock(subOrders, { session }) {
    const flipped = [];
    for (const sub of subOrders) {
      // The flag flips first: a second caller matches nothing and restocks nothing.
      const claimed = await SubOrder.updateOne(
        { _id: sub._id, stockRestored: false },
        { $set: { stockRestored: true } },
        { session },
      );
      if (claimed.matchedCount !== 1) continue;
      for (const item of sub.items) {
        const after = await Product.findOneAndUpdate(
          { _id: item.productId },
          { $inc: { stockQty: item.quantity } },
          { session, returnDocument: 'after', projection: { slug: 1, stockQty: 1 } },
        );
        if (after && after.stockQty === item.quantity) flipped.push(after); // was 0
      }
    }
    if (flipped.length)
      await searchOutbox.enqueue(
        flipped.map((p) => p._id),
        { session },
      );
    return flipped;
  }

  /** Releases the coupon reservation of an order, once (the redemption's status is the guard). */
  async function releaseCoupon(orderId, { session }) {
    const redemption = await CouponRedemption.findOneAndUpdate(
      { orderId, status: 'reserved' },
      { $set: { status: 'released' } },
      { session },
    );
    if (!redemption) return false;
    await Coupon.updateOne(
      { _id: redemption.couponId, usedCount: { $gt: 0 } },
      { $inc: { usedCount: -1 } },
      { session },
    );
    return true;
  }

  return {
    restoreStock,
    releaseCoupon,
    invalidateProducts,

    /**
     * pending_payment -> expired, with stock and coupon restored in the same transaction.
     * `expired: false` means someone else already moved the order (it was paid, or already
     * expired): not an error.
     */
    async expireOrder(orderId, { reason = 'reservation_expired', now = new Date() } = {}) {
      const result = await inTransaction(async (session) => {
        const order = await Order.findOneAndUpdate(
          { _id: orderId, status: 'pending_payment' },
          { $set: { status: 'expired' } },
          { session, returnDocument: 'after' },
        );
        if (!order) return { expired: false, flipped: [] };

        const subOrders = await SubOrder.find({ orderId }).session(session);
        const flipped = await restoreStock(subOrders, { session });
        await SubOrder.updateMany(
          { orderId },
          {
            $set: { fulfillmentStatus: 'cancelled' },
            $push: { statusHistory: { status: 'cancelled', at: now, note: reason } },
          },
          { session },
        );
        await releaseCoupon(orderId, { session });
        return { expired: true, flipped };
      });
      await invalidateProducts(result.flipped.map((p) => p.slug));
      if (result.expired) logger.info({ orderId: String(orderId), reason }, 'order.expired');
      return { expired: result.expired };
    },
  };
}
