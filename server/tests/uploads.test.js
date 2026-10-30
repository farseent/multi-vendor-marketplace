import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearDb, startTestDb, stopTestDb } from './db.js';
import { makeVendor, signUp } from './factories.js';
import { buildTestApp, fakeStorage } from './helpers.js';

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

const presign = (auth, body, target = app) =>
  request(target)
    .post('/api/v1/vendor/uploads/presign')
    .set(auth ?? {})
    .send(body);

describe('POST /vendor/uploads/presign', () => {
  it.each([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
  ])('issues a URL for %s under the vendor own prefix', async (contentType, ext) => {
    const vendor = await makeVendor(app, 'v@example.com');
    const res = await presign(vendor.auth, { contentType, sizeBytes: 123_456 });
    expect(res.status).toBe(201);
    const { key, uploadUrl, headers, publicUrl, method, expiresInSeconds } = res.body.data;
    expect(key).toMatch(new RegExp(`^products/${vendor.shop.id}/[0-9a-f-]{36}\\.${ext}$`));
    expect(method).toBe('PUT');
    expect(headers).toEqual({ 'Content-Type': contentType });
    expect(publicUrl).toBe(`https://cdn.test/${key}`);
    expect(expiresInSeconds).toBe(300);
    expect(uploadUrl).toContain(key);
    expect(uploadUrl).toContain('len=123456'); // size is part of what gets signed
  });

  it('accepts exactly 5 MB and rejects one byte more', async () => {
    const vendor = await makeVendor(app, 'v@example.com');
    const max = 5 * 1024 * 1024;
    expect((await presign(vendor.auth, { contentType: 'image/png', sizeBytes: max })).status).toBe(
      201,
    );
    const over = await presign(vendor.auth, { contentType: 'image/png', sizeBytes: max + 1 });
    expect(over.status).toBe(422);
    expect(over.body.error.details[0].path).toBe('body.sizeBytes');
  });

  it.each([
    ['gif', { contentType: 'image/gif', sizeBytes: 1000 }],
    ['pdf', { contentType: 'application/pdf', sizeBytes: 1000 }],
    ['svg (can carry scripts)', { contentType: 'image/svg+xml', sizeBytes: 1000 }],
    ['zero size', { contentType: 'image/png', sizeBytes: 0 }],
    ['negative size', { contentType: 'image/png', sizeBytes: -5 }],
    ['fractional size', { contentType: 'image/png', sizeBytes: 10.5 }],
    ['size as string', { contentType: 'image/png', sizeBytes: '1000' }],
    ['missing size', { contentType: 'image/png' }],
    ['missing type', { sizeBytes: 1000 }],
    [
      'client-chosen key',
      { contentType: 'image/png', sizeBytes: 1000, key: 'products/other/x.png' },
    ],
  ])('rejects: %s', async (_label, body) => {
    const vendor = await makeVendor(app, 'v@example.com');
    const res = await presign(vendor.auth, body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('works for a pending shop (drafts need images) but needs a shop and the vendor role', async () => {
    const pending = await makeVendor(app, 'p@example.com');
    expect(pending.shop.status).toBe('pending');
    const body = { contentType: 'image/webp', sizeBytes: 5000 };
    expect((await presign(pending.auth, body)).status).toBe(201);

    const noShop = await signUp(app, 'n@example.com', 'register-vendor');
    expect((await presign(noShop.auth, body)).status).toBe(403);
    const customer = await signUp(app, 'c@example.com');
    expect((await presign(customer.auth, body)).status).toBe(403);
    expect((await presign(undefined, body)).status).toBe(401);
  });

  it('two vendors never get keys in each other prefix', async () => {
    const a = await makeVendor(app, 'a@example.com', { shopName: 'Shop A' });
    const b = await makeVendor(app, 'b@example.com', { shopName: 'Shop B' });
    const body = { contentType: 'image/png', sizeBytes: 1000 };
    const keyA = (await presign(a.auth, body)).body.data.key;
    const keyB = (await presign(b.auth, body)).body.data.key;
    expect(keyA.startsWith(`products/${a.shop.id}/`)).toBe(true);
    expect(keyB.startsWith(`products/${b.shop.id}/`)).toBe(true);
  });

  it('answers 503 SERVICE_UNAVAILABLE when S3 is not configured', async () => {
    const noStorage = buildTestApp({ storage: null });
    const vendor = await makeVendor(noStorage, 'v@example.com');
    const res = await presign(
      vendor.auth,
      { contentType: 'image/png', sizeBytes: 1000 },
      noStorage,
    );
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('passes the approved size, type and TTL to the storage layer', async () => {
    const calls = [];
    const spy = buildTestApp({
      storage: {
        ...fakeStorage,
        presignPut: async (args) => {
          calls.push(args);
          return 'https://s3.test/signed';
        },
      },
    });
    const vendor = await makeVendor(spy, 'v@example.com');
    await presign(vendor.auth, { contentType: 'image/jpeg', sizeBytes: 777 }, spy);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ contentType: 'image/jpeg', sizeBytes: 777, expiresIn: 300 });
    expect(calls[0].key).toMatch(new RegExp(`^products/${vendor.shop.id}/`));
  });

  it('rate-limits to 30 per hour per vendor (31st -> 429 with Retry-After)', async () => {
    const vendor = await makeVendor(app, 'v@example.com');
    const body = { contentType: 'image/png', sizeBytes: 1000 };
    for (let i = 0; i < 30; i++) {
      expect((await presign(vendor.auth, body)).status).toBe(201);
    }
    const limited = await presign(vendor.auth, body);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});
