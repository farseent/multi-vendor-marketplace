import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { clearDb, startTestDb, stopTestDb } from './db.js';
import { makeAdmin, makeVendor, signUp } from './factories.js';
import { buildTestApp } from './helpers.js';

let replSet;
let app;
beforeAll(async () => {
  replSet = await startTestDb();
}, 60_000);
afterAll(() => stopTestDb(replSet));
beforeEach(async () => {
  await clearDb();
  app = buildTestApp();
});

const api = (method, path, auth, body) => {
  const agent = request(app);
  const req = agent[method](`/api/v1${path}`).set(auth ?? {});
  return body === undefined ? req : req.send(body);
};

describe('vendor shop profile', () => {
  it('creates a pending shop with a slug, once', async () => {
    const vendor = await signUp(app, 'v@example.com', 'register-vendor');
    const created = await api('post', '/vendor/profile', vendor.auth, {
      shopName: 'Loom & Co!',
      description: 'Handmade textiles',
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      shopName: 'Loom & Co!',
      shopSlug: 'loom-co',
      status: 'pending',
      commissionRateBps: null,
      payoutAccount: { provider: 'razorpay', status: 'not_created' },
    });
    expect(created.body.data._id).toBeUndefined();

    const again = await api('post', '/vendor/profile', vendor.auth, { shopName: 'Another' });
    expect(again.status).toBe(409);
  });

  it('gives a colliding shop name a unique slug', async () => {
    const a = await makeVendor(app, 'a@example.com', { shopName: 'Loom Co' });
    const b = await makeVendor(app, 'b@example.com', { shopName: 'Loom Co' });
    expect(a.shop.shopSlug).toBe('loom-co');
    expect(b.shop.shopSlug).toMatch(/^loom-co-[a-z0-9]{4}$/);
  });

  it('GET/PATCH /vendor/profile work for a pending vendor; 404 before a shop exists', async () => {
    const noShop = await signUp(app, 'v@example.com', 'register-vendor');
    expect((await api('get', '/vendor/profile', noShop.auth)).status).toBe(404);
    expect((await api('patch', '/vendor/profile', noShop.auth, { shopName: 'Nope' })).status).toBe(
      404,
    );

    const owner = await makeVendor(app, 'y@example.com', { shopName: 'Old Name' });
    expect((await api('get', '/vendor/profile', owner.auth)).body.data.status).toBe('pending');
    const patched = await api('patch', '/vendor/profile', owner.auth, {
      shopName: 'New Name',
      description: 'Hello',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({ shopName: 'New Name', description: 'Hello' });
    expect(patched.body.data.shopSlug).toBe(owner.shop.shopSlug); // slug is stable
  });

  it('only accepts a logo key inside the shop own upload prefix', async () => {
    const a = await makeVendor(app, 'a@example.com', { shopName: 'Shop A' });
    const b = await makeVendor(app, 'b@example.com', { shopName: 'Shop B' });

    const foreign = await api('patch', '/vendor/profile', a.auth, {
      logoKey: `products/${b.shop.id}/abcd1234.png`,
    });
    expect(foreign.status).toBe(422);
    expect(foreign.body.error.details[0].path).toBe('body.logoKey');

    const own = await api('patch', '/vendor/profile', a.auth, {
      logoKey: `products/${a.shop.id}/abcd1234.png`,
    });
    expect(own.status).toBe(200);
    expect(own.body.data.logoUrl).toBe(`https://cdn.test/products/${a.shop.id}/abcd1234.png`);
  });

  it.each([
    ['short name', { shopName: 'ab' }],
    ['unknown field', { shopName: 'Good Name', status: 'approved' }],
    ['long description', { shopName: 'Good Name', description: 'x'.repeat(1001) }],
  ])('rejects invalid create: %s', async (_label, body) => {
    const vendor = await signUp(app, 'v@example.com', 'register-vendor');
    expect((await api('post', '/vendor/profile', vendor.auth, body)).status).toBe(422);
  });

  it('a vendor cannot approve their own shop or set commission through PATCH', async () => {
    const vendor = await makeVendor(app, 'v@example.com');
    for (const body of [{ status: 'approved' }, { commissionRateBps: 0 }]) {
      expect((await api('patch', '/vendor/profile', vendor.auth, body)).status).toBe(422);
    }
  });

  it('customers cannot use the vendor profile routes (403)', async () => {
    const customer = await signUp(app, 'c@example.com');
    expect((await api('get', '/vendor/profile', customer.auth)).status).toBe(403);
    expect(
      (await api('post', '/vendor/profile', customer.auth, { shopName: 'Sneaky' })).status,
    ).toBe(403);
  });
});

describe('admin vendor approval', () => {
  it('lists vendors with owner info and filters by status', async () => {
    const admin = await makeAdmin(app);
    await makeVendor(app, 'a@example.com', { shopName: 'Shop A', approved: true });
    await makeVendor(app, 'b@example.com', { shopName: 'Shop B' });

    const all = await api('get', '/admin/vendors', admin.auth);
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(2);
    expect(all.body.meta).toMatchObject({ page: 1, limit: 20, total: 2, totalPages: 1 });
    expect(all.body.data[0].owner.email).toMatch(/@example\.com$/);
    expect(JSON.stringify(all.body)).not.toContain('passwordHash');

    const pending = await api('get', '/admin/vendors?status=pending', admin.auth);
    expect(pending.body.data.map((v) => v.shopName)).toEqual(['Shop B']);
    expect((await api('get', '/admin/vendors?status=bogus', admin.auth)).status).toBe(422);
  });

  it('follows the transition table, rejects the rest with 409, and writes audit logs', async () => {
    const admin = await makeAdmin(app);
    const vendor = await makeVendor(app, 'v@example.com');
    const set = (status) =>
      api('patch', `/admin/vendors/${vendor.shop.id}/status`, admin.auth, { status });

    expect((await set('suspended')).status).toBe(409); // pending -> suspended not allowed
    expect((await set('approved')).body.data.status).toBe('approved');
    expect((await set('approved')).status).toBe(409); // no-op is a conflict
    expect((await set('rejected')).status).toBe(409); // approved -> rejected not allowed
    expect((await set('suspended')).body.data.status).toBe('suspended');
    expect((await set('approved')).body.data.status).toBe('approved'); // reinstated

    const logs = await AuditLog.find({ entityType: 'vendor' }).sort({ createdAt: 1 });
    expect(logs.map((l) => l.meta.to)).toEqual(['approved', 'suspended', 'approved']);
    expect(logs[0]).toMatchObject({ action: 'vendor.status_changed', actorRole: 'admin' });
    expect(String(logs[0].actorId)).toBe(admin.id);
  });

  it('rejects "pending" as a target and unknown vendors', async () => {
    const admin = await makeAdmin(app);
    const vendor = await makeVendor(app, 'v@example.com');
    expect(
      (
        await api('patch', `/admin/vendors/${vendor.shop.id}/status`, admin.auth, {
          status: 'pending',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await api('patch', `/admin/vendors/${'0'.repeat(24)}/status`, admin.auth, {
          status: 'approved',
        })
      ).status,
    ).toBe(404);
    expect(
      (await api('patch', '/admin/vendors/not-an-id/status', admin.auth, { status: 'approved' }))
        .status,
    ).toBe(422);
  });

  it('sets and clears the commission override (0-5000 bps, integers only)', async () => {
    const admin = await makeAdmin(app);
    const vendor = await makeVendor(app, 'v@example.com');
    const url = `/admin/vendors/${vendor.shop.id}/commission`;

    const set = await api('patch', url, admin.auth, { commissionRateBps: 1250 });
    expect(set.body.data.commissionRateBps).toBe(1250);
    expect(
      (await api('patch', url, admin.auth, { commissionRateBps: 0 })).body.data.commissionRateBps,
    ).toBe(0);
    expect(
      (await api('patch', url, admin.auth, { commissionRateBps: null })).body.data
        .commissionRateBps,
    ).toBeNull();

    for (const bad of [5001, -1, 10.5, '10']) {
      expect((await api('patch', url, admin.auth, { commissionRateBps: bad })).status).toBe(422);
    }
    expect(await AuditLog.countDocuments({ action: 'vendor.commission_changed' })).toBe(3);
  });

  it('is admin-only: vendors and customers get 403', async () => {
    const vendor = await makeVendor(app, 'v@example.com');
    const customer = await signUp(app, 'c@example.com');
    for (const who of [vendor, customer]) {
      expect((await api('get', '/admin/vendors', who.auth)).status).toBe(403);
      expect(
        (
          await api('patch', `/admin/vendors/${vendor.shop.id}/status`, who.auth, {
            status: 'approved',
          })
        ).status,
      ).toBe(403);
    }
  });
});

describe('public shop page', () => {
  it('shows approved shops only, without private fields', async () => {
    const admin = await makeAdmin(app);
    const vendor = await makeVendor(app, 'v@example.com', { shopName: 'Loom Co' });

    expect((await api('get', '/shops/loom-co')).status).toBe(404); // pending is invisible
    await api('patch', `/admin/vendors/${vendor.shop.id}/status`, admin.auth, {
      status: 'approved',
    });
    await api('patch', `/admin/vendors/${vendor.shop.id}/commission`, admin.auth, {
      commissionRateBps: 900,
    });

    const res = await api('get', '/shops/loom-co');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(
      ['description', 'id', 'logoUrl', 'shopName', 'shopSlug'].sort(),
    );

    await api('patch', `/admin/vendors/${vendor.shop.id}/status`, admin.auth, {
      status: 'suspended',
    });
    expect((await api('get', '/shops/loom-co')).status).toBe(404); // suspended disappears
    expect((await api('get', '/shops/Not_A_Slug!')).status).toBe(422);
  });
});
