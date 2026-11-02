import jwt from 'jsonwebtoken';
import request from 'supertest';
import { expect } from 'vitest';
import { Cart } from '../src/modules/cart/cart.model.js';
import { Coupon } from '../src/modules/coupons/coupons.model.js';
import { User } from '../src/modules/users/users.model.js';
import { makeCategory, makeVendor, productBody, signUp } from './factories.js';
import { TEST_AUTH_CONFIG } from './helpers.js';

export const api = (app, method, path, auth, body) => {
  const req = request(app)
    [method](`/api/v1${path}`)
    .set(auth ?? {});
  return body === undefined ? req : req.send(body);
};

const ADDRESS = {
  label: 'Home',
  name: 'Asha K',
  phone: '+919876543210',
  line1: '12 Lake Rd',
  city: 'Kochi',
  state: 'Kerala',
  postalCode: '682001',
};

/** A signed-up customer with one saved address. Returns { id, auth, addressId }. */
export async function makeCustomer(app, email = 'cust@example.com') {
  const customer = await signUp(app, email);
  const res = await api(app, 'post', '/users/me/addresses', customer.auth, ADDRESS);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { ...customer, addressId: res.body.data.id };
}

/**
 * A customer inserted straight into the database (no HTTP), for tests that need dozens of them:
 * the register rate limit (5/hour/IP) would otherwise refuse the sixth sign-up.
 * `cart` = [{ productId, quantity }].
 */
export async function makeCustomerDirect(email, cart = []) {
  const user = await User.create({
    email,
    name: 'Bulk Buyer',
    passwordHash: 'not-a-real-hash',
    addresses: [{ ...ADDRESS, isDefault: true }],
  });
  if (cart.length) await Cart.create({ customerId: user._id, items: cart });
  const token = jwt.sign({ role: 'customer' }, TEST_AUTH_CONFIG.jwtSecret, {
    subject: user.id,
    expiresIn: 600,
  });
  return {
    id: user.id,
    auth: { Authorization: `Bearer ${token}` },
    addressId: user.addresses[0].id,
  };
}

export { makeCategory };

let sku = 0;
/** An active product (default 10,000 paise, stock 20) in the vendor's shop. */
export async function addProduct(app, vendor, category, overrides = {}) {
  const res = await api(
    app,
    'post',
    '/vendor/products',
    vendor.auth,
    productBody(vendor.shop.id, category.id, {
      sku: `SKU-${++sku}`,
      status: 'active',
      pricePaise: 10000,
      stockQty: 20,
      ...overrides,
    }),
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

/** Approved vendors, one category and a customer with an address. */
export async function setupMarket(app, { vendors = 2 } = {}) {
  const made = [];
  for (let i = 0; i < vendors; i++) {
    made.push(
      await makeVendor(app, `vendor${i}@example.com`, {
        approved: true,
        shopName: `Shop Number ${i}`,
      }),
    );
  }
  const category = await makeCategory();
  const customer = await makeCustomer(app);
  return { vendors: made, category, customer };
}

export async function fillCart(app, customer, lines) {
  for (const { productId, quantity } of lines) {
    const res = await api(app, 'put', `/cart/items/${productId}`, customer.auth, { quantity });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
}

let keySeq = 0;
export const newKey = () => `test-key-${Date.now()}-${++keySeq}`;

export function checkout(app, customer, { key = newKey(), body } = {}) {
  const req = request(app).post('/api/v1/checkout').set(customer.auth).set('Idempotency-Key', key);
  return req.send(body ?? { addressId: customer.addressId });
}

const day = 86_400_000;
export const makeCoupon = (overrides = {}) =>
  Coupon.create({
    code: 'SAVE10',
    scope: 'platform',
    fundedBy: 'platform',
    type: 'percent',
    value: 10,
    startsAt: new Date(Date.now() - day),
    expiresAt: new Date(Date.now() + day),
    ...overrides,
  });
