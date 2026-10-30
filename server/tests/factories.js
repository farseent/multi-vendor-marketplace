import request from 'supertest';
import { Category } from '../src/modules/catalog/categories.model.js';
import { Vendor } from '../src/modules/shops/shops.model.js';
import { User } from '../src/modules/users/users.model.js';

export const PASSWORD = 'S3cure!pass99';
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

/** Registers a user through the real API. Returns { id, auth } (auth = Authorization header). */
export async function signUp(app, email, path = 'register') {
  const res = await request(app)
    .post(`/api/v1/auth/${path}`)
    .send({ name: 'Test User', email, password: PASSWORD });
  return { id: res.body.data.user.id, auth: bearer(res.body.data.accessToken) };
}

/** Admin accounts only exist via the seed script, so promote directly, then log in for a token. */
export async function makeAdmin(app, email = 'admin@example.com') {
  const { id } = await signUp(app, email);
  await User.updateOne({ _id: id }, { role: 'admin' });
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { id, auth: bearer(res.body.data.accessToken) };
}

/** A vendor user with a shop. Pass approved: true to skip the admin step. */
export async function makeVendor(app, email, { approved = false, shopName = 'Loom and Co' } = {}) {
  const user = await signUp(app, email, 'register-vendor');
  const res = await request(app).post('/api/v1/vendor/profile').set(user.auth).send({ shopName });
  const shop = res.body.data;
  if (approved) await Vendor.updateOne({ _id: shop.id }, { status: 'approved' });
  return { ...user, shop };
}

export const makeCategory = (overrides = {}) =>
  Category.create({
    name: 'Clothing',
    slug: `clothing-${Math.random().toString(36).slice(2, 7)}`,
    ...overrides,
  });

/** A valid POST /vendor/products body for the given vendor and category. */
export const productBody = (vendorId, categoryId, overrides = {}) => ({
  title: 'Handloom Cotton Kurta',
  description: 'Soft handloom cotton.',
  categoryId: String(categoryId),
  pricePaise: 149900,
  sku: 'KRT-001',
  stockQty: 25,
  images: [{ key: `products/${vendorId}/9f2a1c3e.webp`, alt: 'Front view' }],
  ...overrides,
});
