import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_VENDORS } from '../src/scripts/demoData.js';
import { seedDemo } from '../src/scripts/seedDemo.js';

// A tiny in-memory stand-in for the API: it only knows the calls the seed script makes and the
// answers API_CONTRACTS documents (401 unknown login, 409 duplicates). It checks the SCRIPT's logic
// (login first, skip duplicates, approve once); it cannot prove the real API accepts the bodies.
function fakeApi() {
  const users = new Map(); // email -> { token, role }
  const shops = new Map(); // token -> { id, status }
  const categories = [];
  const skus = new Set();
  const calls = [];
  let coupons = 0;

  const handler = (req, res, body) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const send = (status, data, error) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(error ? { success: false, error } : { success: true, data }));
    };
    const route = `${req.method} ${req.url}`;
    calls.push(route);
    if (route === 'POST /auth/login') {
      const user = users.get(body.email);
      return user
        ? send(200, { accessToken: user.token })
        : send(401, null, { code: 'UNAUTHENTICATED' });
    }
    if (route === 'POST /auth/register' || route === 'POST /auth/register-vendor') {
      users.set(body.email, { token: `t-${users.size}`, role: 'x' });
      return send(201, { accessToken: users.get(body.email).token });
    }
    if (route === 'GET /categories') return send(200, categories);
    if (route === 'POST /admin/categories') {
      const created = { id: `c${categories.length}`, name: body.name, children: [] };
      categories.push(created);
      return send(201, created);
    }
    if (route === 'POST /vendor/profile') {
      if (shops.has(token)) return send(409, null, { code: 'CONFLICT' });
      shops.set(token, { id: `s${shops.size}`, status: 'pending' });
      return send(201, shops.get(token));
    }
    if (route === 'GET /vendor/profile') return send(200, shops.get(token));
    if (route.startsWith('PATCH /admin/vendors/')) {
      for (const shop of shops.values()) if (req.url.includes(shop.id)) shop.status = 'approved';
      return send(200, {});
    }
    if (route === 'POST /vendor/products') {
      const key = `${token}:${body.sku}`;
      if (skus.has(key)) return send(409, null, { code: 'CONFLICT' });
      skus.add(key);
      return send(201, { id: key });
    }
    if (route === 'POST /admin/coupons') {
      if (coupons) return send(409, null, { code: 'CONFLICT' });
      coupons += 1;
      return send(201, {});
    }
    return send(404, null, { code: 'NOT_FOUND' });
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => handler(req, res, raw ? JSON.parse(raw) : {}));
  });
  return { server, users, shops, calls };
}

describe('seedDemo', () => {
  const api = fakeApi();
  let baseUrl;
  const productCount = DEMO_VENDORS.flatMap((v) => v.products).length;

  beforeAll(async () => {
    api.users.set('admin@x.example', { token: 'admin-token', role: 'admin' });
    await new Promise((resolve) => api.server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${api.server.address().port}`;
  });
  afterAll(() => new Promise((resolve) => api.server.close(resolve)));

  const run = () =>
    seedDemo({ baseUrl, adminEmail: 'admin@x.example', adminPassword: 'x', log: () => {} });

  it('creates categories, approved shops, products and the coupon on a fresh API', async () => {
    const summary = await run();
    expect(summary).toEqual({ categories: 5, vendors: 3, products: productCount, coupons: 1 });
    expect([...api.shops.values()].every((shop) => shop.status === 'approved')).toBe(true);
  });

  it('is safe to run twice: nothing is created again and nobody is registered twice', async () => {
    const registersBefore = api.calls.filter((c) => c.includes('/auth/register')).length;
    const summary = await run();
    expect(summary).toEqual({ categories: 0, vendors: 0, products: 0, coupons: 0 });
    expect(api.calls.filter((c) => c.includes('/auth/register')).length).toBe(registersBefore);
  });
});
