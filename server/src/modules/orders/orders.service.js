import { AppError } from '../../lib/AppError.js';
import { pageMeta, skipFor } from '../../lib/pagination.js';
import { Payment } from '../payments/payments.model.js';
import { Vendor } from '../shops/shops.model.js';
import { Order, SubOrder } from './orders.model.js';

const notFound = () => new AppError('NOT_FOUND', 404, 'Order not found');

/**
 * Customer-facing order reads. Every query carries `customerId` (D15): another customer's order is
 * a plain 404. Commission and vendor payout are internal and never leave the server.
 */
export function createOrdersService({ paymentProvider, storage = null }) {
  const imageUrl = (key) => (storage && key ? storage.publicUrl(key) : null);

  const presentSubOrder = (sub, shop) => ({
    id: sub.id,
    subOrderNumber: sub.subOrderNumber,
    shop: shop ? { name: shop.shopName, slug: shop.shopSlug } : null,
    items: sub.items.map((item) => ({
      productId: String(item.productId),
      title: item.title,
      sku: item.sku,
      imageUrl: imageUrl(item.imageKey),
      unitPricePaise: item.unitPricePaise,
      quantity: item.quantity,
      lineSubtotalPaise: item.lineSubtotalPaise,
      discountPaise: item.discountPaise,
      lineNetPaise: item.lineNetPaise,
    })),
    subtotalPaise: sub.subtotalPaise,
    discountPaise: sub.discountPaise,
    shippingPaise: sub.shippingPaise,
    customerTotalPaise: sub.customerTotalPaise,
    fulfillmentStatus: sub.fulfillmentStatus,
    refundStatus: sub.refundStatus,
    refundedPaise: sub.refundedPaise,
    tracking: sub.tracking ?? null,
    deliveredAt: sub.deliveredAt ?? null,
    returnWindowEndsAt: sub.returnWindowEndsAt ?? null,
  });

  const summary = (order) => ({
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

  return {
    async list(customerId, { page, limit }) {
      const filter = { customerId };
      const [orders, total] = await Promise.all([
        Order.find(filter).sort({ createdAt: -1 }).skip(skipFor({ page, limit })).limit(limit),
        Order.countDocuments(filter),
      ]);
      return { items: orders.map(summary), meta: pageMeta({ page, limit }, total) };
    },

    async get(customerId, orderId) {
      const order = await Order.findOne({ _id: orderId, customerId });
      if (!order) throw notFound();
      const subOrders = await SubOrder.find({ orderId: order._id }).sort({ subOrderNumber: 1 });
      const shops = await Vendor.find({ _id: { $in: subOrders.map((s) => s.vendorId) } });
      const shopById = new Map(shops.map((s) => [s.id, s]));

      const view = {
        ...summary(order),
        subtotalPaise: order.subtotalPaise,
        discountPaise: order.discountPaise,
        shippingPaise: order.shippingPaise,
        shippingAddress: order.shippingAddress,
        coupon: order.coupon
          ? { code: order.coupon.code, discountPaise: order.coupon.discountPaise }
          : null,
        subOrders: subOrders.map((sub) => presentSubOrder(sub, shopById.get(String(sub.vendorId)))),
      };
      if (order.status === 'pending_payment') {
        // Lets the page resume an unfinished payment after a reload.
        const payment = await Payment.findOne({ orderId: order._id });
        view.reservationExpiresAt = order.reservationExpiresAt;
        view.payment = payment?.providerOrderId
          ? {
              provider: payment.provider,
              providerOrderId: payment.providerOrderId,
              keyId: paymentProvider.publicKeyId,
              amountPaise: payment.amountPaise,
              currency: payment.currency,
            }
          : null;
      }
      return view;
    },
  };
}
