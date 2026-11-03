import { expect } from 'vitest';
import { Order, SubOrder } from '../src/modules/orders/orders.model.js';
import { Settlement } from '../src/modules/settlements/settlements.model.js';
import { addProduct, api, checkout, fillCart, makeCoupon, setupMarket } from './phase5.helpers.js';

/**
 * A PAID order (status placed, sub-orders processing) with `vendorCount` vendors, one product each.
 * `prices`/`quantities` are per vendor. Returns the customer, vendors, products and the sub-order
 * documents in vendor order.
 */
export async function paidOrder(
  app,
  ledger,
  { vendorCount = 1, prices = [], quantities = [], stock = 20, coupon = null } = {},
) {
  const { vendors, category, customer } = await setupMarket(app, { vendors: vendorCount });
  const products = [];
  for (let i = 0; i < vendorCount; i++) {
    products.push(
      await addProduct(app, vendors[i], category, {
        pricePaise: prices[i] ?? 10000,
        stockQty: stock,
      }),
    );
  }
  if (coupon) await makeCoupon(coupon);
  await fillCart(
    app,
    customer,
    products.map((p, i) => ({ productId: p.id, quantity: quantities[i] ?? 2 })),
  );
  if (coupon) await api(app, 'post', '/cart/coupon', customer.auth, { code: coupon.code });
  const res = await checkout(app, customer);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const orderId = res.body.data.order.id;
  const providerOrderId = res.body.data.payment.providerOrderId;
  const pay = ledger.simulatePayment(providerOrderId);
  const verified = await api(app, 'post', '/payments/verify', customer.auth, {
    orderId,
    razorpayOrderId: providerOrderId,
    razorpayPaymentId: pay.providerPaymentId,
    razorpaySignature: pay.signature,
  });
  expect(verified.body.data.status, JSON.stringify(verified.body)).toBe('placed');

  const subs = await SubOrder.find({ orderId });
  // Vendor order = the order the vendors were created in (sub-orders are numbered by vendor id).
  const byVendor = vendors.map((v) => subs.find((s) => String(s.vendorId) === v.shop.id));
  return { customer, vendors, products, orderId, providerOrderId, subs: byVendor, pay };
}

export const subOrderOf = (id) => SubOrder.findById(id);
export const settlementOf = (subId) => Settlement.findOne({ subOrderId: subId });
export const orderOf = (id) => Order.findById(id);

/** vendor PATCH /vendor/sub-orders/:id/status */
export const setStatus = (app, vendor, subId, body) =>
  api(app, 'patch', `/vendor/sub-orders/${subId}/status`, vendor.auth, body);

export const TRACKING = { carrier: 'DTDC', trackingNumber: 'D123456' };

/** Moves a paid sub-order to shipped, then delivered, through the real API. */
export async function deliver(app, vendor, subId) {
  const shipped = await setStatus(app, vendor, subId, { status: 'shipped', tracking: TRACKING });
  expect(shipped.status, JSON.stringify(shipped.body)).toBe(200);
  const delivered = await setStatus(app, vendor, subId, { status: 'delivered' });
  expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
  return delivered.body.data;
}
