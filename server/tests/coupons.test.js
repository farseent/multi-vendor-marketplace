import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { Coupon } from '../src/modules/coupons/coupons.model.js';
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
  const req = request(app)
    [method](`/api/v1${path}`)
    .set(auth ?? {});
  return body === undefined ? req : req.send(body);
};

const day = 86_400_000;
const couponBody = (overrides = {}) => ({
  code: 'WELCOME10',
  type: 'percent',
  value: 10,
  startsAt: new Date(Date.now() - day).toISOString(),
  expiresAt: new Date(Date.now() + 30 * day).toISOString(),
  ...overrides,
});

describe('vendor coupons', () => {
  it('an approved vendor creates a vendor-funded coupon tied to their own shop', async () => {
    const vendor = await makeVendor(app, 'v@example.com', { approved: true });
    const res = await api(
      'post',
      '/vendor/coupons',
      vendor.auth,
      couponBody({ code: 'loom15', value: 15 }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      code: 'LOOM15', // normalised to uppercase
      scope: 'vendor',
      fundedBy: 'vendor',
      vendorId: vendor.shop.id,
      type: 'percent',
      value: 15,
      minOrderPaise: 0,
      usageLimitPerUser: 1,
      usedCount: 0,
      status: 'active',
    });
  });

  it('cannot choose scope, funding, vendor or usage counters (422)', async () => {
    const vendor = await makeVendor(app, 'v@example.com', { approved: true });
    for (const extra of [
      { scope: 'platform' },
      { fundedBy: 'platform' },
      { vendorId: '0'.repeat(24) },
      { usedCount: 99 },
    ]) {
      const res = await api('post', '/vendor/coupons', vendor.auth, couponBody(extra));
      expect(res.status, JSON.stringify(extra)).toBe(422);
    }
    expect(await Coupon.countDocuments()).toBe(0);
  });

  it('requires an approved shop (403 VENDOR_NOT_APPROVED) and an existing shop (403 FORBIDDEN)', async () => {
    const pending = await makeVendor(app, 'p@example.com');
    for (const [method, path, body] of [
      ['get', '/vendor/coupons'],
      ['post', '/vendor/coupons', couponBody()],
      ['get', `/vendor/coupons/${'0'.repeat(24)}`],
      ['patch', `/vendor/coupons/${'0'.repeat(24)}`, { status: 'disabled' }],
    ]) {
      const res = await api(method, path, pending.auth, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error.code).toBe('VENDOR_NOT_APPROVED');
    }

    const noShop = await signUp(app, 'noshop@example.com', 'register-vendor');
    const res = await api('get', '/vendor/coupons', noShop.auth);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it.each([
    ['percent above 90', { value: 91 }, 'body.value'],
    ['fixed under 100 paise', { type: 'fixed', value: 99 }, 'body.value'],
    [
      'a cap on a fixed coupon',
      { type: 'fixed', value: 500, maxDiscountPaise: 100 },
      'body.maxDiscountPaise',
    ],
    [
      'expiry before start',
      { expiresAt: new Date(Date.now() - 2 * day).toISOString() },
      'body.expiresAt',
    ],
  ])('rejects %s with a field path', async (_name, overrides, path) => {
    const vendor = await makeVendor(app, 'v@example.com', { approved: true });
    const res = await api('post', '/vendor/coupons', vendor.auth, couponBody(overrides));
    expect(res.status).toBe(422);
    expect(res.body.error.details.map((d) => d.path)).toContain(path);
  });

  it.each([
    ['too short', { code: 'AB' }],
    ['bad characters', { code: 'SAVE 10!' }],
    ['not ISO dates', { startsAt: '01/11/2026' }],
    ['fractional value', { value: 10.5 }],
    ['zero per-user limit', { usageLimitPerUser: 0 }],
    ['string value', { value: '10' }],
  ])('rejects malformed input: %s', async (_name, overrides) => {
    const vendor = await makeVendor(app, 'v@example.com', { approved: true });
    const res = await api('post', '/vendor/coupons', vendor.auth, couponBody(overrides));
    expect(res.status).toBe(422);
  });

  it('answers 409 for a duplicate code, even across vendors', async () => {
    const a = await makeVendor(app, 'a@example.com', { approved: true, shopName: 'Alpha Shop' });
    const b = await makeVendor(app, 'b@example.com', { approved: true, shopName: 'Beta Shop' });
    expect((await api('post', '/vendor/coupons', a.auth, couponBody())).status).toBe(201);
    const dup = await api('post', '/vendor/coupons', b.auth, couponBody());
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT');
  });

  it('lists and reads only its own coupons; another vendor gets 404 for get and patch', async () => {
    const a = await makeVendor(app, 'a@example.com', { approved: true, shopName: 'Alpha Shop' });
    const b = await makeVendor(app, 'b@example.com', { approved: true, shopName: 'Beta Shop' });
    const mine = (await api('post', '/vendor/coupons', a.auth, couponBody({ code: 'ALPHA10' })))
      .body.data;
    await api('post', '/vendor/coupons', b.auth, couponBody({ code: 'BETA10' }));
    const admin = await makeAdmin(app);
    await api('post', '/admin/coupons', admin.auth, couponBody({ code: 'PLATFORM10' }));

    const list = await api('get', '/vendor/coupons', a.auth);
    expect(list.body.data.map((c) => c.code)).toEqual(['ALPHA10']);
    expect(list.body.meta).toMatchObject({ page: 1, limit: 20, total: 1, totalPages: 1 });

    expect((await api('get', `/vendor/coupons/${mine.id}`, a.auth)).status).toBe(200);
    for (const res of [
      await api('get', `/vendor/coupons/${mine.id}`, b.auth),
      await api('patch', `/vendor/coupons/${mine.id}`, b.auth, { status: 'disabled' }),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
    expect((await Coupon.findById(mine.id)).status).toBe('active'); // untouched
  });

  it('filters by status and paginates', async () => {
    const v = await makeVendor(app, 'v@example.com', { approved: true });
    for (const [i, status] of ['active', 'active', 'disabled'].entries()) {
      await api('post', '/vendor/coupons', v.auth, couponBody({ code: `CODE-${i}AAA`, status }));
    }
    const disabled = await api('get', '/vendor/coupons?status=disabled', v.auth);
    expect(disabled.body.data).toHaveLength(1);
    const page = await api('get', '/vendor/coupons?limit=2&page=2', v.auth);
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta).toMatchObject({ page: 2, limit: 2, total: 3, totalPages: 2 });
    expect((await api('get', '/vendor/coupons?limit=500', v.auth)).status).toBe(422);
  });

  it('updates limits and status, clears optional fields with null, and checks the combination', async () => {
    const v = await makeVendor(app, 'v@example.com', { approved: true });
    const c = (
      await api(
        'post',
        '/vendor/coupons',
        v.auth,
        couponBody({ maxDiscountPaise: 5000, usageLimitTotal: 10 }),
      )
    ).body.data;

    const edited = await api('patch', `/vendor/coupons/${c.id}`, v.auth, {
      value: 20,
      minOrderPaise: 30000,
      usageLimitTotal: null,
      maxDiscountPaise: null,
      status: 'disabled',
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ value: 20, minOrderPaise: 30000, status: 'disabled' });
    expect(edited.body.data).not.toHaveProperty('usageLimitTotal');
    expect(edited.body.data).not.toHaveProperty('maxDiscountPaise');

    // the combined result must still be valid
    const tooBig = await api('patch', `/vendor/coupons/${c.id}`, v.auth, { value: 95 });
    expect(tooBig.status).toBe(422);
    const backwards = await api('patch', `/vendor/coupons/${c.id}`, v.auth, {
      expiresAt: new Date(Date.now() - 5 * day).toISOString(),
    });
    expect(backwards.status).toBe(422);
  });

  it('cannot change code, type, scope, owner or usedCount', async () => {
    const v = await makeVendor(app, 'v@example.com', { approved: true });
    const c = (await api('post', '/vendor/coupons', v.auth, couponBody())).body.data;
    for (const patch of [
      { code: 'OTHER10' },
      { type: 'fixed' },
      { scope: 'platform' },
      { vendorId: '0'.repeat(24) },
      { usedCount: 0 },
      {},
    ]) {
      const res = await api('patch', `/vendor/coupons/${c.id}`, v.auth, patch);
      expect(res.status, JSON.stringify(patch)).toBe(422);
    }
  });

  it('a patch does not overwrite usedCount that checkout changed in the meantime', async () => {
    const v = await makeVendor(app, 'v@example.com', { approved: true });
    const c = (await api('post', '/vendor/coupons', v.auth, couponBody())).body.data;
    await Coupon.updateOne({ _id: c.id }, { $inc: { usedCount: 3 } });
    await api('patch', `/vendor/coupons/${c.id}`, v.auth, { minOrderPaise: 100 });
    expect((await Coupon.findById(c.id)).usedCount).toBe(3);
  });
});

describe('admin (platform) coupons', () => {
  it('creates a platform-funded coupon and audits it', async () => {
    const admin = await makeAdmin(app);
    const res = await api(
      'post',
      '/admin/coupons',
      admin.auth,
      couponBody({ code: 'FESTIVE20', value: 20 }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      scope: 'platform',
      fundedBy: 'platform',
      code: 'FESTIVE20',
    });
    expect(res.body.data).not.toHaveProperty('vendorId');

    const log = await AuditLog.findOne({ action: 'coupon.created' });
    expect(log).toMatchObject({ entityType: 'coupon', actorRole: 'admin' });
    expect(String(log.entityId)).toBe(res.body.data.id);
  });

  it('lists, reads and updates platform coupons, auditing each change', async () => {
    const admin = await makeAdmin(app);
    const c = (await api('post', '/admin/coupons', admin.auth, couponBody())).body.data;

    expect((await api('get', '/admin/coupons', admin.auth)).body.data).toHaveLength(1);
    expect((await api('get', `/admin/coupons/${c.id}`, admin.auth)).body.data.id).toBe(c.id);

    const upd = await api('patch', `/admin/coupons/${c.id}`, admin.auth, { status: 'disabled' });
    expect(upd.status).toBe(200);
    expect(upd.body.data.status).toBe('disabled');
    const log = await AuditLog.findOne({ action: 'coupon.updated' });
    expect(log.meta).toMatchObject({ code: 'WELCOME10', fields: ['status'] });
  });

  it("only sees platform coupons: a vendor's coupon is a 404 for the admin", async () => {
    const v = await makeVendor(app, 'v@example.com', { approved: true });
    const admin = await makeAdmin(app);
    const vc = (await api('post', '/vendor/coupons', v.auth, couponBody({ code: 'VENDORONLY' })))
      .body.data;

    expect((await api('get', '/admin/coupons', admin.auth)).body.data).toEqual([]);
    expect((await api('get', `/admin/coupons/${vc.id}`, admin.auth)).status).toBe(404);
    expect(
      (await api('patch', `/admin/coupons/${vc.id}`, admin.auth, { status: 'disabled' })).status,
    ).toBe(404);
    expect(await AuditLog.countDocuments({ action: 'coupon.updated' })).toBe(0);
  });

  it('is closed to customers and vendors', async () => {
    const customer = await signUp(app, 'c@example.com');
    const v = await makeVendor(app, 'v@example.com', { approved: true });
    for (const auth of [customer.auth, v.auth]) {
      expect((await api('post', '/admin/coupons', auth, couponBody())).status).toBe(403);
      expect((await api('get', '/admin/coupons', auth)).status).toBe(403);
    }
    expect((await api('post', '/vendor/coupons', customer.auth, couponBody())).status).toBe(403);
  });

  it('validates like the vendor route (combination rules, unknown keys)', async () => {
    const admin = await makeAdmin(app);
    expect(
      (await api('post', '/admin/coupons', admin.auth, couponBody({ value: 99 }))).status,
    ).toBe(422);
    expect(
      (await api('post', '/admin/coupons', admin.auth, couponBody({ scope: 'vendor' }))).status,
    ).toBe(422);
    expect((await api('get', `/admin/coupons/not-an-id`, admin.auth)).status).toBe(422);
  });
});
