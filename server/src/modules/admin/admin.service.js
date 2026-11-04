import mongoose from 'mongoose';
import { ADMIN_PRODUCT_TRANSITIONS, CACHE } from '../../config/constants.js';
import { AppError } from '../../lib/AppError.js';
import { pageMeta, skipFor } from '../../lib/pagination.js';
import { Product } from '../catalog/products.model.js';
import { Order, SubOrder } from '../orders/orders.model.js';
import { Payment } from '../payments/payments.model.js';
import { Refund } from '../refunds/refunds.model.js';
import { Review } from '../reviews/reviews.model.js';
import { Settlement } from '../settlements/settlements.model.js';
import { Vendor } from '../shops/shops.model.js';
import { User } from '../users/users.model.js';

const inTransaction = (work) => mongoose.connection.transaction(work);
const notFound = (what) => new AppError('NOT_FOUND', 404, `${what} not found`);
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const byId = (docs) => new Map(docs.map((d) => [d.id, d]));
const person = (user) => (user ? { id: user.id, name: user.name, email: user.email } : null);

/**
 * Admin read models for the console (Phase 8) and product moderation. Everything under /admin
 * is already role-gated in app.js; these are the pieces that do not belong to one earlier module:
 * the product list and suspend/restore, the review moderation list and the order views.
 * Read endpoints never write; the one mutation here (product status) is audited in the same
 * transaction as the change (D49, D65).
 */
export function createAdminService({ audit, cache, searchOutbox }) {
  return {
    // ---------------------------------------------------------------- products

    async listProducts({ status, vendorId, q, page, limit }) {
      const filter = {
        ...(status && { status }),
        ...(vendorId && { vendorId }),
        // The text is escaped, so it is always a literal substring, never a pattern.
        ...(q && { title: { $regex: escapeRegex(q), $options: 'i' } }),
      };
      const [products, total] = await Promise.all([
        Product.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip(skipFor({ page, limit }))
          .limit(limit),
        Product.countDocuments(filter),
      ]);
      const shops = byId(
        await Vendor.find({ _id: { $in: products.map((p) => p.vendorId) } }, 'shopName shopSlug'),
      );
      const items = products.map((p) => ({
        id: p.id,
        slug: p.slug,
        title: p.title,
        sku: p.sku,
        status: p.status,
        pricePaise: p.pricePaise,
        stockQty: p.stockQty,
        ratingAvg: p.ratingAvg,
        ratingCount: p.ratingCount,
        shop: shops.get(String(p.vendorId))
          ? {
              id: String(p.vendorId),
              name: shops.get(String(p.vendorId)).shopName,
              slug: shops.get(String(p.vendorId)).shopSlug,
            }
          : null,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      }));
      return { items, meta: pageMeta({ page, limit }, total) };
    },

    /**
     * PATCH /admin/products/:id/status (D65). `suspended` hides the product everywhere; `draft`
     * is the only way back, and the vendor publishes it again. One conditional update on the
     * status that was read, so two admins acting together change it once; the search outbox
     * entry and the audit entry commit with it.
     */
    async setProductStatus(actor, productId, status) {
      const product = await Product.findById(productId);
      if (!product) throw notFound('Product');
      const from = product.status;
      if (!ADMIN_PRODUCT_TRANSITIONS[from]?.includes(status)) {
        throw new AppError(
          'INVALID_STATE_TRANSITION',
          409,
          `A ${from} product cannot be changed to ${status}`,
        );
      }
      const updated = await inTransaction(async (session) => {
        const doc = await Product.findOneAndUpdate(
          { _id: product._id, status: from },
          { $set: { status } },
          { returnDocument: 'after', session },
        );
        if (!doc) {
          throw new AppError(
            'INVALID_STATE_TRANSITION',
            409,
            'Product status changed, reload and retry',
          );
        }
        await searchOutbox.enqueue([doc._id], { session });
        await audit.record(
          actor,
          {
            action: 'product.status_changed',
            entityType: 'product',
            entityId: doc._id,
            meta: { from, to: status, vendorId: String(doc.vendorId) },
          },
          { session },
        );
        return doc;
      });
      await cache.del(CACHE.keys.product(updated.slug));
      return { id: updated.id, slug: updated.slug, status: updated.status, previousStatus: from };
    },

    // ----------------------------------------------------------------- reviews

    async listReviews({ status, productId, rating, page, limit }) {
      const filter = {
        ...(status && { status }),
        ...(productId && { productId }),
        ...(rating && { rating }),
      };
      const [reviews, total] = await Promise.all([
        Review.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip(skipFor({ page, limit }))
          .limit(limit),
        Review.countDocuments(filter),
      ]);
      const [products, users] = await Promise.all([
        Product.find({ _id: { $in: reviews.map((r) => r.productId) } }, 'title slug'),
        User.find({ _id: { $in: reviews.map((r) => r.customerId) } }, 'name email'),
      ]);
      const productById = byId(products);
      const userById = byId(users);
      const items = reviews.map((r) => ({
        id: r.id,
        status: r.status,
        rating: r.rating,
        title: r.title ?? null,
        body: r.body,
        product: productById.get(String(r.productId))
          ? {
              id: String(r.productId),
              title: productById.get(String(r.productId)).title,
              slug: productById.get(String(r.productId)).slug,
            }
          : { id: String(r.productId), title: null, slug: null },
        customer: person(userById.get(String(r.customerId))),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
      return { items, meta: pageMeta({ page, limit }, total) };
    },

    // ------------------------------------------------------------------ orders

    async listOrders({ status, paymentStatus, refundStatus, q, page, limit }) {
      const filter = {
        ...(status && { status }),
        ...(paymentStatus && { paymentStatus }),
        ...(refundStatus && { refundStatus }),
        // Order numbers are upper case (MP-YYYYMMDD-NNNNNN): an anchored prefix can use the index.
        ...(q && { orderNumber: { $regex: `^${escapeRegex(q.toUpperCase())}` } }),
      };
      const [orders, total] = await Promise.all([
        Order.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip(skipFor({ page, limit }))
          .limit(limit),
        Order.countDocuments(filter),
      ]);
      const customers = byId(
        await User.find({ _id: { $in: orders.map((o) => o.customerId) } }, 'name email'),
      );
      const items = orders.map((o) => ({
        ...orderSummary(o),
        customer: person(customers.get(String(o.customerId))),
      }));
      return { items, meta: pageMeta({ page, limit }, total) };
    },

    /** One order with everything an admin needs to act on it: sub-orders, refunds, settlements. */
    async getOrder(orderId, { now = new Date() } = {}) {
      const order = await Order.findById(orderId);
      if (!order) throw notFound('Order');
      const [customer, payment, subOrders, refunds, settlements] = await Promise.all([
        User.findById(order.customerId, 'name email'),
        Payment.findOne({ orderId: order._id }),
        SubOrder.find({ orderId: order._id }).sort({ subOrderNumber: 1 }),
        Refund.find({ orderId: order._id }).sort({ createdAt: 1 }),
        Settlement.find({ orderId: order._id }),
      ]);
      const shops = byId(
        await Vendor.find({ _id: { $in: subOrders.map((s) => s.vendorId) } }, 'shopName shopSlug'),
      );
      const settlementBySub = new Map(settlements.map((s) => [String(s.subOrderId), s]));

      return {
        ...orderSummary(order),
        customer: person(customer),
        subtotalPaise: order.subtotalPaise,
        discountPaise: order.discountPaise,
        shippingPaise: order.shippingPaise,
        shippingAddress: order.shippingAddress,
        coupon: order.coupon
          ? {
              code: order.coupon.code,
              fundedBy: order.coupon.fundedBy,
              discountPaise: order.coupon.discountPaise,
            }
          : null,
        payment: payment
          ? {
              provider: payment.provider,
              status: payment.status,
              method: payment.method ?? null,
              amountPaise: payment.amountPaise,
              providerOrderId: payment.providerOrderId ?? null,
              providerPaymentId: payment.providerPaymentId ?? null,
              capturedAt: payment.capturedAt ?? null,
            }
          : null,
        subOrders: subOrders.map((sub) => {
          const shop = shops.get(String(sub.vendorId));
          const settlement = settlementBySub.get(sub.id);
          return {
            id: sub.id,
            subOrderNumber: sub.subOrderNumber,
            shop: {
              id: String(sub.vendorId),
              name: shop?.shopName ?? null,
              slug: shop?.shopSlug ?? null,
            },
            items: sub.items.map((i) => ({
              productId: String(i.productId),
              title: i.title,
              sku: i.sku,
              unitPricePaise: i.unitPricePaise,
              quantity: i.quantity,
              lineNetPaise: i.lineNetPaise,
            })),
            subtotalPaise: sub.subtotalPaise,
            discountPaise: sub.discountPaise,
            shippingPaise: sub.shippingPaise,
            customerTotalPaise: sub.customerTotalPaise,
            commission: {
              rateBps: sub.commission.rateBps,
              rateSource: sub.commission.rateSource,
              amountPaise: sub.commission.amountPaise,
            },
            vendorPayoutPaise: sub.vendorPayoutPaise,
            fulfillmentStatus: sub.fulfillmentStatus,
            tracking: sub.tracking ?? null,
            deliveredAt: sub.deliveredAt ?? null,
            returnWindowEndsAt: sub.returnWindowEndsAt ?? null,
            refundStatus: sub.refundStatus,
            refundedPaise: sub.refundedPaise,
            refundablePaise: refundableNow(sub, now),
            statusHistory: sub.statusHistory.map((h) => ({ status: h.status, at: h.at })),
            refunds: refunds
              .filter((r) => String(r.subOrderId) === sub.id)
              .map((r) => ({
                id: r.id,
                status: r.status,
                reason: r.reason,
                note: r.note ?? null,
                amountPaise: r.amountPaise,
                commissionReversedPaise: r.commissionReversedPaise,
                vendorDebitPaise: r.vendorDebitPaise,
                createdAt: r.createdAt,
              })),
            settlement: settlement
              ? {
                  id: settlement.id,
                  status: settlement.status,
                  grossPaise: settlement.grossPaise,
                  commissionPaise: settlement.commissionPaise,
                  refundAdjustmentPaise: settlement.refundAdjustmentPaise,
                  netPayoutPaise: settlement.netPayoutPaise,
                  eligibleAt: settlement.eligibleAt ?? null,
                  releasedAt: settlement.releasedAt ?? null,
                }
              : null,
          };
        }),
        // Refunds that cover the whole order and no single sub-order (a late capture, Phase 5).
        orderRefunds: refunds
          .filter((r) => !r.subOrderId)
          .map((r) => ({
            id: r.id,
            status: r.status,
            reason: r.reason,
            amountPaise: r.amountPaise,
            createdAt: r.createdAt,
          })),
      };
    },
  };
}

const orderSummary = (order) => ({
  id: order.id,
  orderNumber: order.orderNumber,
  status: order.status,
  paymentStatus: order.paymentStatus,
  refundStatus: order.refundStatus,
  currency: order.currency,
  totalPaise: order.totalPaise,
  placedAt: order.placedAt ?? null,
  createdAt: order.createdAt,
});

/**
 * How much an admin refund could still take from this sub-order right now. A display hint for
 * the console's refund button, mirroring the checks of POST /admin/sub-orders/:id/refund (paid,
 * not cancelled, inside the return window); the endpoint stays the authority.
 */
function refundableNow(sub, now) {
  const paid = sub.statusHistory.some((h) => h.status === 'processing');
  if (!paid || ['pending_payment', 'cancelled'].includes(sub.fulfillmentStatus)) return 0;
  if (sub.fulfillmentStatus === 'delivered' && now > sub.returnWindowEndsAt) return 0;
  return Math.max(0, sub.customerTotalPaise - sub.refundedPaise);
}
