import { Order, SubOrder } from '../src/modules/orders/orders.model.js';

let seq = 0;
const ADDRESS = {
  label: 'Home',
  name: 'Asha Kumar',
  phone: '+919876543210',
  line1: '12 Lake Rd',
  city: 'Kochi',
  state: 'Kerala',
  postalCode: '682001',
  country: 'IN',
};

/**
 * Gives `customerId` a paid order with one sub-order that contains `product` (the body returned by
 * POST /vendor/products), written straight to the database: reviews only look at the sub-order's
 * state, and tests that need several reviewers cannot afford a full checkout each.
 * `fulfillmentStatus` defaults to `delivered`, the state that makes a customer eligible.
 */
export async function grantPurchase(
  customerId,
  product,
  { fulfillmentStatus = 'delivered', paymentStatus = 'paid', refundedPaise = 0, quantity = 1 } = {},
) {
  const n = ++seq;
  const amount = product.pricePaise * quantity;
  const orderNumber = `MP-20260101-${String(n).padStart(6, '0')}`;
  const order = await Order.create({
    orderNumber,
    customerId,
    status: 'placed',
    paymentStatus,
    shippingAddress: ADDRESS,
    subtotalPaise: amount,
    discountPaise: 0,
    shippingPaise: 0,
    totalPaise: amount,
    idempotencyKey: `seed-key-${n}`,
    placedAt: new Date(),
  });
  const sub = await SubOrder.create({
    subOrderNumber: `${orderNumber}-V1`,
    orderId: order._id,
    customerId,
    vendorId: product.vendorId,
    items: [
      {
        productId: product.id,
        title: product.title,
        sku: product.sku,
        unitPricePaise: product.pricePaise,
        quantity,
        lineSubtotalPaise: amount,
        discountPaise: 0,
        lineNetPaise: amount,
      },
    ],
    subtotalPaise: amount,
    discountPaise: 0,
    shippingPaise: 0,
    customerTotalPaise: amount,
    commission: {
      rateBps: 1000,
      rateSource: 'platform',
      amountPaise: Math.floor(amount / 10),
      basePaise: amount,
    },
    vendorPayoutPaise: amount - Math.floor(amount / 10),
    fulfillmentStatus,
    refundedPaise,
    deliveredAt: fulfillmentStatus === 'delivered' ? new Date() : undefined,
  });
  return { order, sub };
}
