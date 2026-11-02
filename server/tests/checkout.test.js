import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Cart } from '../src/modules/cart/cart.model.js';
import { Product } from '../src/modules/catalog/products.model.js';
import { Coupon } from '../src/modules/coupons/coupons.model.js';
import { CouponRedemption } from '../src/modules/coupons/redemptions.model.js';
import { Order, SubOrder } from '../src/modules/orders/orders.model.js';
import { Payment } from '../src/modules/payments/payments.model.js';
import { SearchOutbox } from '../src/modules/search/search.model.js';
import { Settlement } from '../src/modules/settlements/settlements.model.js';
import { Vendor } from '../src/modules/shops/shops.model.js';
import { createMockLedger } from '../src/providers/payment/mockLedger.js';
import { clearDb, startTestDb, stopTestDb } from './db.js';
import { makeAdmin, signUp } from './factories.js';
import { buildTestApp } from './helpers.js';
import {
  addProduct,
  api,
  checkout,
  fillCart,
  makeCoupon,
  makeCustomerDirect,
  newKey,
  setupMarket,
} from './phase5.helpers.js';

let replSet;
let app;
let ledger;
beforeAll(async () => {
  replSet = await startTestDb();
}, 60_000);
afterAll(() => stopTestDb(replSet));
beforeEach(async () => {
  await clearDb();
  ledger = createMockLedger();
  app = buildTestApp({ paymentProvider: ledger });
});

describe('a successful checkout', () => {
  it('creates the order, sub-order, settlement and payment and reserves the stock', async () => {
    const { vendors, category, customer } = await setupMarket(app, { vendors: 1 });
    const p1 = await addProduct(app, vendors[0], category, { pricePaise: 149900, stockQty: 25 });
    const p2 = await addProduct(app, vendors[0], category, { pricePaise: 5000, stockQty: 3 });
    await fillCart(app, customer, [
      { productId: p1.id, quantity: 2 },
      { productId: p2.id, quantity: 3 },
    ]);

    const res = await checkout(app, customer);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { order, payment } = res.body.data;
    expect(order).toMatchObject({
      status: 'pending_payment',
      subtotalPaise: 2 * 149900 + 3 * 5000,
      discountPaise: 0,
      shippingPaise: 0,
      totalPaise: 2 * 149900 + 3 * 5000,
    });
    expect(order.orderNumber).toMatch(/^MP-\d{8}-\d{6}$/);
    const minutes = (new Date(order.reservationExpiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14.5);
    expect(minutes).toBeLessThanOrEqual(15);
    expect(payment).toMatchObject({
      provider: 'mock',
      keyId: 'rzp_test_mock',
      amountPaise: order.totalPaise,
      currency: 'INR',
    });
    expect(payment.providerOrderId).toMatch(/^order_mock_/);

    // stock reserved, cart emptied
    expect((await Product.findById(p1.id)).stockQty).toBe(23);
    expect((await Product.findById(p2.id)).stockQty).toBe(0);
    const cart = await api(app, 'get', '/cart', customer.auth);
    expect(cart.body.data.items).toEqual([]);

    // documents
    const dbOrder = await Order.findById(order.id);
    expect(dbOrder).toMatchObject({
      paymentStatus: 'unpaid',
      refundStatus: 'none',
      currency: 'INR',
    });
    expect(dbOrder.shippingAddress).toMatchObject({ name: 'Asha K', postalCode: '682001' });
    const [sub] = await SubOrder.find({ orderId: order.id });
    expect(sub.subOrderNumber).toBe(`${order.orderNumber}-V1`);
    expect(sub.fulfillmentStatus).toBe('pending_payment');
    expect(sub.commission).toMatchObject({ rateBps: 1000, rateSource: 'platform' });
    expect(sub.commission.amountPaise + sub.vendorPayoutPaise).toBe(sub.commission.basePaise);
    const [settlement] = await Settlement.find({ orderId: order.id });
    expect(settlement).toMatchObject({
      status: 'not_eligible',
      grossPaise: sub.commission.basePaise,
      commissionPaise: sub.commission.amountPaise,
      netPayoutPaise: sub.vendorPayoutPaise,
    });
    expect(settlement.providerTransferId).toMatch(/^trf_mock_/);
    const dbPayment = await Payment.findOne({ orderId: order.id });
    expect(dbPayment).toMatchObject({
      status: 'created',
      providerOrderId: payment.providerOrderId,
    });

    // the provider order carries one on-hold transfer for the vendor payout
    const call = ledger.state.calls.find((c) => c.method === 'createOrder');
    expect(call.args.amountPaise).toBe(order.totalPaise);
    expect(call.args.transfers).toEqual([
      expect.objectContaining({
        linkedAccountId: `acc_mock${vendors[0].shop.id}`,
        amountPaise: sub.vendorPayoutPaise,
      }),
    ]);
  });

  it('splits a 3-vendor cart into 1 order and 3 sub-orders that add up', async () => {
    const { vendors, category, customer } = await setupMarket(app, { vendors: 3 });
    const products = [];
    for (const [i, v] of vendors.entries()) {
      products.push(await addProduct(app, v, category, { pricePaise: 12345 + i * 777 }));
    }
    await fillCart(
      app,
      customer,
      products.map((p, i) => ({ productId: p.id, quantity: i + 1 })),
    );

    const res = await checkout(app, customer);
    expect(res.status).toBe(201);
    const orderId = res.body.data.order.id;
    const subs = await SubOrder.find({ orderId }).sort({ subOrderNumber: 1 });
    expect(await Order.countDocuments()).toBe(1);
    expect(subs).toHaveLength(3);
    expect(subs.map((s) => s.subOrderNumber)).toEqual(
      [1, 2, 3].map((n) => expect.stringMatching(new RegExp(`-V${n}$`))),
    );
    expect(subs.reduce((s, x) => s + x.customerTotalPaise, 0)).toBe(res.body.data.order.totalPaise);
    for (const s of subs)
      expect(s.commission.amountPaise + s.vendorPayoutPaise).toBe(s.commission.basePaise);
    expect(await Settlement.countDocuments({ orderId })).toBe(3);
    const transfers = ledger.state.calls.find((c) => c.method === 'createOrder').args.transfers;
    expect(transfers).toHaveLength(3);
  });

  it('uses the vendor override, then the platform default, for the commission snapshot', async () => {
    const { vendors, category, customer } = await setupMarket(app, { vendors: 2 });
    await Vendor.updateOne({ _id: vendors[0].shop.id }, { commissionRateBps: 250 });
    const a = await addProduct(app, vendors[0], category, { pricePaise: 20000 });
    const b = await addProduct(app, vendors[1], category, { pricePaise: 20000 });
    await fillCart(app, customer, [
      { productId: a.id, quantity: 1 },
      { productId: b.id, quantity: 1 },
    ]);
    const res = await checkout(app, customer);
    const subs = await SubOrder.find({ orderId: res.body.data.order.id });
    const byVendor = new Map(subs.map((s) => [String(s.vendorId), s]));
    expect(byVendor.get(vendors[0].shop.id).commission).toMatchObject({
      rateBps: 250,
      rateSource: 'vendor',
      amountPaise: 500,
    });
    expect(byVendor.get(vendors[1].shop.id).commission).toMatchObject({
      rateBps: 1000,
      rateSource: 'platform',
      amountPaise: 2000,
    });
  });

  it('enqueues a search update and keeps the numbers right when the last unit is taken', async () => {
    const { vendors, category, customer } = await setupMarket(app, { vendors: 1 });
    const p = await addProduct(app, vendors[0], category, { stockQty: 2 });
    await SearchOutbox.deleteMany({});
    await fillCart(app, customer, [{ productId: p.id, quantity: 2 }]);
    expect((await checkout(app, customer)).status).toBe(201);
    expect(await SearchOutbox.countDocuments({ productId: p.id })).toBe(1);
  });
});

describe('coupons at checkout (D6, D21)', () => {
  it('applies a vendor-funded coupon only to that vendor and reserves it', async () => {
    const { vendors, category, customer } = await setupMarket(app, { vendors: 2 });
    const a = await addProduct(app, vendors[0], category, { pricePaise: 100000 });
    const b = await addProduct(app, vendors[1], category, { pricePaise: 100000 });
    const coupon = await makeCoupon({
      code: 'VEND10',
      scope: 'vendor',
      fundedBy: 'vendor',
      vendorId: vendors[0].shop.id,
      value: 10,
    });
    await fillCart(app, customer, [
      { productId: a.id, quantity: 1 },
      { productId: b.id, quantity: 1 },
    ]);
    await api(app, 'post', '/cart/coupon', customer.auth, { code: 'VEND10' });

    const res = await checkout(app, customer);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.order).toMatchObject({ discountPaise: 10000, totalPaise: 190000 });
    const subs = await SubOrder.find({ orderId: res.body.data.order.id });
    const mine = subs.find((s) => String(s.vendorId) === vendors[0].shop.id);
    const other = subs.find((s) => String(s.vendorId) === vendors[1].shop.id);
    expect(mine).toMatchObject({ discountPaise: 10000, customerTotalPaise: 90000 });
    expect(mine.commission.basePaise).toBe(90000); // vendor-funded: the vendor carries it
    expect(other.discountPaise).toBe(0);
    expect((await Coupon.findById(coupon.id)).usedCount).toBe(1);
    expect(await CouponRedemption.findOne({ couponId: coupon.id })).toMatchObject({
      status: 'reserved',
      discountPaise: 10000,
    });
    expect((await Order.findById(res.body.data.order.id)).coupon).toMatchObject({
      code: 'VEND10',
      fundedBy: 'vendor',
      discountPaise: 10000,
    });
  });

  it('platform-funded: the customer pays less and the vendor payout is unchanged', async () => {
    const { vendors, category, customer } = await setupMarket(app, { vendors: 1 });
    const p = await addProduct(app, vendors[0], category, { pricePaise: 100000 });
    await makeCoupon({ code: 'PLAT10' }); // 10% platform-funded, 10% commission: exactly on the limit
    await fillCart(app, customer, [{ productId: p.id, quantity: 1 }]);
    const res = await checkout(app, customer, {
      body: { addressId: customer.addressId, couponCode: 'plat10' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.order.totalPaise).toBe(90000);
    const [sub] = await SubOrder.find({ orderId: res.body.data.order.id });
    expect(sub.commission.basePaise).toBe(100000);
    expect(sub.vendorPayoutPaise).toBe(90000);
  });

  it('couponCode in the body wins over the saved one, and null means no coupon', async () => {
    const { vendors, category, customer } = await setupMarket(app, { vendors: 1 });
    const p = await addProduct(app, vendors[0], category, { pricePaise: 100000, stockQty: 50 });
    await makeCoupon({ code: 'SAVED5', value: 5 });
    await makeCoupon({ code: 'BODY5', value: 5, usageLimitPerUser: 5 });
    await fillCart(app, customer, [{ productId: p.id, quantity: 1 }]);
    await api(app, 'post', '/cart/coupon', customer.auth, { code: 'SAVED5' });
    const none = await checkout(app, customer, {
      body: { addressId: customer.addressId, couponCode: null },
    });
    expect(none.body.data.order.discountPaise).toBe(0);
    await fillCart(app, customer, [{ productId: p.id, quantity: 1 }]);
    await api(app, 'post', '/cart/coupon', customer.auth, { code: 'SAVED5' });
    const body = await checkout(app, customer, {
      body: { addressId: customer.addressId, couponCode: 'BODY5' },
    });
    expect((await Order.findById(body.body.data.order.id)).coupon.code).toBe('BODY5');
  });

  it('re-validates at checkout: an expired saved coupon is a 422 and nothing is written', async () => {
    const { vendors, category, customer } = await setupMarket(app, { vendors: 1 });
    const p = await addProduct(app, vendors[0], category);
    const coupon = await makeCoupon({ code: 'WILLEXPIRE' });
    await fillCart(app, customer, [{ productId: p.id, quantity: 2 }]);
    await api(app, 'post', '/cart/coupon', customer.auth, { code: 'WILLEXPIRE' });
    await Coupon.updateOne({ _id: coupon.id }, { expiresAt: new Date(Date.now() - 1000) });

    const res = await checkout(app, customer);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({
      code: 'COUPON_INVALID',
      details: { reason: 'expired' },
    });
    expect(await Order.countDocuments()).toBe(0);
    expect((await Product.findById(p.id)).stockQty).toBe(20);
    expect((await Cart.findOne({ customerId: customer.id })).items).toHaveLength(1);
  });

  it('a coupon at its total limit cannot be reserved', async () => {
    const { vendors, category, customer } = await setupMarket(app, { vendors: 1 });
    const p = await addProduct(app, vendors[0], category);
    await makeCoupon({ code: 'ONLYONE', usageLimitTotal: 1, usedCount: 1 });
    await fillCart(app, customer, [{ productId: p.id, quantity: 1 }]);
    const res = await checkout(app, customer, {
      body: { addressId: customer.addressId, couponCode: 'ONLYONE' },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toBe('total_limit_reached');
  });
});

describe('rejections write nothing (D47, D49, D50)', () => {
  async function expectUntouched(customer, product, { stock = 20, quantity = 1 } = {}) {
    expect(await Order.countDocuments()).toBe(0);
    expect((await Product.findById(product.id)).stockQty).toBe(stock);
    expect((await Cart.findOne({ customerId: customer.id })).items[0].quantity).toBe(quantity);
    expect(await CouponRedemption.countDocuments()).toBe(0);
    expect(ledger.state.calls.filter((c) => c.method === 'createOrder')).toHaveLength(0);
  }

  it('zero_total: a coupon that takes everything off', async () => {
    const { vendors, category, customer } = await setupMarket(app, { vendors: 1 });
    const p = await addProduct(app, vendors[0], category, { pricePaise: 10000 });
    const coupon = await makeCoupon({ code: 'FREE', type: 'fixed', value: 50000 });
    await fillCart(app, customer, [{ productId: p.id, quantity: 1 }]);
    const res = await checkout(app, customer, {
      body: { addressId: customer.addressId, couponCode: 'FREE' },
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'zero_total' },
    });
    await expectUntouched(customer, p);
    expect((await Coupon.findById(coupon.id)).usedCount).toBe(0);
  });

  it('below_minimum_total: 1-99 paise left', async () => {
    const { vendors, category, customer } = await setupMarket(app, { vendors: 1 });
    const p = await addProduct(app, vendors[0], category, { pricePaise: 149 });
    await makeCoupon({ code: 'ALMOST', type: 'fixed', value: 100 });
    await fillCart(app, customer, [{ productId: p.id, quantity: 1 }]);
    const res = await checkout(app, customer, {
      body: { addressId: customer.addressId, couponCode: 'ALMOST' },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toBe('below_minimum_total');
    await expectUntouched(customer, p);
  });

  it('payout_below_minimum: a 100-paise product leaves the vendor 90 paise', async () => {
    const { vendors, category, customer } = await setupMarket(app, { vendors: 1 });
    const p = await addProduct(app, vendors[0], category, { pricePaise: 100 });
    await fillCart(app, customer, [{ productId: p.id, quantity: 1 }]);
    const res = await checkout(app, customer);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'payout_below_minimum', productIds: [p.id] },
    });
    await expectUntouched(customer, p);
  });

  it('exceeds_platform_margin: a 20% platform coupon on a 10% commission', async () => {
    const { vendors, category, customer } = await setupMarket(app, { vendors: 1 });
    const p = await addProduct(app, vendors[0], category, { pricePaise: 100000 });
    const coupon = await makeCoupon({ code: 'BIG20', value: 20 });
    await fillCart(app, customer, [{ productId: p.id, quantity: 1 }]);
    const res = await checkout(app, customer, {
      body: { addressId: customer.addressId, couponCode: 'BIG20' },
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({
      code: 'COUPON_INVALID',
      details: { reason: 'exceeds_platform_margin' },
    });
    await expectUntouched(customer, p);
    expect((await Coupon.findById(coupon.id)).usedCount).toBe(0);
  });

  it('vendor_payout_unavailable: a vendor without an active payout account', async () => {
    const noAccount = {
      ...ledger,
      resolvePayoutAccount: async () => ({ linkedAccountId: null, active: false }),
    };
    app = buildTestApp({ paymentProvider: noAccount });
    const { vendors, category, customer } = await setupMarket(app, { vendors: 1 });
    const p = await addProduct(app, vendors[0], category);
    await fillCart(app, customer, [{ productId: p.id, quantity: 1 }]);
    const res = await checkout(app, customer);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'vendor_payout_unavailable', productIds: [p.id] },
    });
    await expectUntouched(customer, p);
  });

  it('OUT_OF_STOCK when stock dropped below the cart quantity', async () => {
    const { vendors, category, customer } = await setupMarket(app, { vendors: 1 });
    const p = await addProduct(app, vendors[0], category, { stockQty: 5 });
    await fillCart(app, customer, [{ productId: p.id, quantity: 4 }]);
    await Product.updateOne({ _id: p.id }, { stockQty: 2 });
    const res = await checkout(app, customer);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'OUT_OF_STOCK',
      details: [{ productId: p.id, available: 2 }],
    });
    await expectUntouched(customer, p, { stock: 2, quantity: 4 });
  });

  it('CONFLICT when a product is no longer sold', async () => {
    const { vendors, category, customer } = await setupMarket(app, { vendors: 1 });
    const p = await addProduct(app, vendors[0], category);
    await fillCart(app, customer, [{ productId: p.id, quantity: 1 }]);
    await Product.updateOne({ _id: p.id }, { status: 'archived' });
    const res = await checkout(app, customer);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CONFLICT', details: { reason: 'unavailable' } });
  });

  it('refuses an empty cart, an unknown address, a missing key and unknown body fields', async () => {
    const { customer } = await setupMarket(app, { vendors: 1 });
    const empty = await checkout(app, customer);
    expect(empty.status).toBe(422);
    expect(empty.body.error.details.reason).toBe('empty_cart');

    const badAddress = await checkout(app, customer, { body: { addressId: '0'.repeat(24) } });
    expect(badAddress.status).toBe(422);
    expect(badAddress.body.error.details[0].path).toBe('body.addressId');

    const noKey = await request(app)
      .post('/api/v1/checkout')
      .set(customer.auth)
      .send({ addressId: customer.addressId });
    expect(noKey.status).toBe(422);
    expect(noKey.body.error.details[0].path).toBe('headers.idempotency-key');

    const shortKey = await checkout(app, customer, { key: 'abc' });
    expect(shortKey.status).toBe(422);

    const extra = await checkout(app, customer, {
      body: { addressId: customer.addressId, totalPaise: 1 },
    });
    expect(extra.status).toBe(422);
  });

  it('is for customers only', async () => {
    const { vendors } = await setupMarket(app, { vendors: 1 });
    const admin = await makeAdmin(app);
    for (const who of [vendors[0], admin]) {
      const res = await checkout(app, { ...who, addressId: '0'.repeat(24) });
      expect(res.status).toBe(403);
    }
    const anon = await request(app)
      .post('/api/v1/checkout')
      .set('Idempotency-Key', newKey())
      .send({});
    expect(anon.status).toBe(401);
  });
});

describe('provider failure compensation (ARCHITECTURE 3.1)', () => {
  it('answers 502, expires the order, restores stock and coupon and gives the cart back', async () => {
    const { vendors, category, customer } = await setupMarket(app, { vendors: 1 });
    const p = await addProduct(app, vendors[0], category, { pricePaise: 100000, stockQty: 10 });
    const coupon = await makeCoupon({ code: 'SAVE5', value: 5 });
    await fillCart(app, customer, [{ productId: p.id, quantity: 3 }]);
    await api(app, 'post', '/cart/coupon', customer.auth, { code: 'SAVE5' });
    ledger.failNext('createOrder');

    const res = await checkout(app, customer);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PAYMENT_PROVIDER_ERROR');

    const [order] = await Order.find();
    expect(order.status).toBe('expired');
    expect((await Product.findById(p.id)).stockQty).toBe(10);
    expect((await Coupon.findById(coupon.id)).usedCount).toBe(0);
    expect((await CouponRedemption.findOne({ orderId: order._id })).status).toBe('released');
    const subs = await SubOrder.find({ orderId: order._id });
    expect(subs.every((s) => s.fulfillmentStatus === 'cancelled' && s.stockRestored)).toBe(true);
    const cart = await api(app, 'get', '/cart', customer.auth);
    expect(cart.body.data.items).toHaveLength(1);
    expect(cart.body.data.items[0].quantity).toBe(3);
    expect(cart.body.data.coupon.code).toBe('SAVE5');
  });
});

describe('concurrency (IMPLEMENTATION_PLAN Phase 5 acceptance)', () => {
  it('50 concurrent checkouts for a product with stock 10: exactly 10 succeed, 40 OUT_OF_STOCK, stock 0', async () => {
    const { vendors, category } = await setupMarket(app, { vendors: 1 });
    const p = await addProduct(app, vendors[0], category, { stockQty: 10 });
    const customers = [];
    for (let i = 0; i < 50; i++) {
      customers.push(
        await makeCustomerDirect(`buyer${i}@example.com`, [{ productId: p.id, quantity: 1 }]),
      );
    }
    const results = await Promise.all(customers.map((c) => checkout(app, c)));
    const ok = results.filter((r) => r.status === 201);
    const oos = results.filter((r) => r.status === 409 && r.body.error.code === 'OUT_OF_STOCK');
    expect(ok).toHaveLength(10);
    expect(oos).toHaveLength(40);
    expect((await Product.findById(p.id)).stockQty).toBe(0);
    expect(await Order.countDocuments()).toBe(10);
    expect(await SubOrder.countDocuments()).toBe(10);
  }, 120_000);

  it('the same Idempotency-Key sent 5 times at once creates exactly 1 order', async () => {
    const { vendors, category, customer } = await setupMarket(app, { vendors: 1 });
    const p = await addProduct(app, vendors[0], category, { stockQty: 10 });
    await fillCart(app, customer, [{ productId: p.id, quantity: 2 }]);
    const key = newKey();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => checkout(app, customer, { key })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.data.order.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.body.data.payment.providerOrderId)).size).toBe(1);
    expect(await Order.countDocuments()).toBe(1);
    expect((await Product.findById(p.id)).stockQty).toBe(8); // reserved once, not five times
    expect(ledger.state.calls.filter((c) => c.method === 'createOrder')).toHaveLength(1);
  }, 60_000);

  it('a later retry with the same key returns the original order unchanged', async () => {
    const { vendors, category, customer } = await setupMarket(app, { vendors: 1 });
    const p = await addProduct(app, vendors[0], category);
    await fillCart(app, customer, [{ productId: p.id, quantity: 1 }]);
    const key = newKey();
    const first = await checkout(app, customer, { key });
    const again = await checkout(app, customer, { key });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual(first.body.data);
  });

  it('two different keys at once for one cart: one order, the other sees an empty cart', async () => {
    const { vendors, category, customer } = await setupMarket(app, { vendors: 1 });
    const p = await addProduct(app, vendors[0], category);
    await fillCart(app, customer, [{ productId: p.id, quantity: 1 }]);
    const [a, b] = await Promise.all([checkout(app, customer), checkout(app, customer)]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    expect(await Order.countDocuments()).toBe(1);
  }, 30_000);
});

describe('GET /orders', () => {
  it('lists and shows the customer’s own orders, hides internals and isolates customers', async () => {
    const { vendors, category, customer } = await setupMarket(app, { vendors: 1 });
    const p = await addProduct(app, vendors[0], category);
    await fillCart(app, customer, [{ productId: p.id, quantity: 1 }]);
    const placed = await checkout(app, customer);
    const orderId = placed.body.data.order.id;

    const list = await api(app, 'get', '/orders', customer.auth);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      id: orderId,
      status: 'pending_payment',
      paymentStatus: 'unpaid',
    });
    expect(list.body.meta).toMatchObject({ page: 1, total: 1 });

    const detail = await api(app, 'get', `/orders/${orderId}`, customer.auth);
    expect(detail.status).toBe(200);
    const d = detail.body.data;
    expect(d.subOrders).toHaveLength(1);
    expect(d.subOrders[0]).toMatchObject({
      shop: { name: 'Shop Number 0' },
      fulfillmentStatus: 'pending_payment',
    });
    expect(d.payment).toMatchObject({ providerOrderId: placed.body.data.payment.providerOrderId });
    expect(JSON.stringify(d)).not.toMatch(/commission|vendorPayout|stockRestored|idempotencyKey/);

    const other = await signUp(app, 'other@example.com');
    expect((await api(app, 'get', `/orders/${orderId}`, other.auth)).status).toBe(404);
    expect((await api(app, 'get', '/orders', other.auth)).body.data).toEqual([]);
    expect((await api(app, 'get', `/orders/${'0'.repeat(24)}`, customer.auth)).status).toBe(404);
    expect((await api(app, 'get', '/orders/not-an-id', customer.auth)).status).toBe(422);
  });
});

describe('checkout rate limit (ARCHITECTURE 8)', () => {
  it('allows 10 per minute per customer and then answers 429', async () => {
    const { customer } = await setupMarket(app, { vendors: 1 });
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await checkout(app, customer)).status);
    expect(statuses.slice(0, 10).every((s) => s === 422)).toBe(true); // empty cart, but counted
    expect(statuses[10]).toBe(429);
  }, 30_000);
});
