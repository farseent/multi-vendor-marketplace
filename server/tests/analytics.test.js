import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearDb, startTestDb, stopTestDb } from './db.js';
import { makeAdmin, makeVendor } from './factories.js';
import { createFakeRedis } from './fakeSearch.js';
import { buildTestApp } from './helpers.js';
import {
  buildFixtures,
  DAY,
  expectedByDay,
  expectedLeaders,
  expectedOverview,
  insertFixtures,
} from './phase8.helpers.js';
import { Vendor } from '../src/modules/shops/shops.model.js';

let replSet;
let app;
let admin;
beforeAll(async () => {
  replSet = await startTestDb();
}, 60_000);
afterAll(() => stopTestDb(replSet));

const without = (obj, ...keys) =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
const get = (path, auth = admin.auth) => request(app).get(`/api/v1${path}`).set(auth);
const START = Date.UTC(2026, 8, 1); // 1 Sep 2026
const range = (fromDay, toDay) => ({
  fromMs: Date.parse(`${fromDay}T00:00:00Z`),
  toMs: Date.parse(`${toDay}T00:00:00Z`) + DAY, // `to` is inclusive
});

describe('analytics equal values recomputed from the fixtures (exactly)', () => {
  let fx;
  beforeAll(async () => {
    await clearDb();
    app = buildTestApp();
    admin = await makeAdmin(app);
    // 60 days of placements; the queried range is the middle 40, so edge orders fall outside.
    fx = buildFixtures({ orders: 900, startMs: START, days: 60, seed: 11 });
    await insertFixtures(fx);
    // Name the shops so the vendor ranking can show them.
    await Vendor.collection.insertMany(
      fx.vendorIds.map((_id, i) => ({
        _id,
        userId: _id,
        shopName: `Shop ${i}`,
        shopSlug: `shop-${i}`,
        status: 'approved',
      })),
    );
  }, 60_000);

  const FROM = '2026-09-11';
  const TO = '2026-10-20';

  it('overview: GMV, commission, order count and the refund figures', async () => {
    const res = await get(`/admin/analytics/overview?from=${FROM}&to=${TO}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const want = expectedOverview(fx, range(FROM, TO));
    expect(want.orderCount).toBeGreaterThan(300); // the fixture really exercises the range
    expect(want.refundedPaise).toBeGreaterThan(0);
    expect(res.body.data).toMatchObject({
      range: { from: FROM, to: TO },
      currency: 'INR',
      ...want,
    });
    expect(typeof res.body.data.generatedAt).toBe('string');
  });

  it('sales-timeseries: every day present, each day and the grand total exact', async () => {
    const res = await get(`/admin/analytics/sales-timeseries?from=${FROM}&to=${TO}&interval=day`);
    expect(res.status).toBe(200);
    const { points, interval } = res.body.data;
    expect(interval).toBe('day');
    expect(points).toHaveLength(40); // 11 Sep .. 20 Oct inclusive, empty days included
    const byDay = expectedByDay(fx, range(FROM, TO));
    for (const p of points) {
      expect(p).toMatchObject(byDay.get(p.bucket) ?? { orderCount: 0, gmvPaise: 0 });
    }
    const want = expectedOverview(fx, range(FROM, TO));
    const sum = (key) => points.reduce((n, p) => n + p[key], 0);
    expect(sum('orderCount')).toBe(want.orderCount);
    expect(sum('gmvPaise')).toBe(want.gmvPaise);
  });

  it('sales-timeseries by month adds up to the same totals', async () => {
    const res = await get(`/admin/analytics/sales-timeseries?from=${FROM}&to=${TO}&interval=month`);
    const { points } = res.body.data;
    expect(points.map((p) => p.bucket)).toEqual(['2026-09', '2026-10']);
    const want = expectedOverview(fx, range(FROM, TO));
    expect(points.reduce((n, p) => n + p.gmvPaise, 0)).toBe(want.gmvPaise);
    expect(points.reduce((n, p) => n + p.orderCount, 0)).toBe(want.orderCount);
  });

  it('top-vendors: ranked by GMV, exact per vendor, with the shop names', async () => {
    const res = await get(`/admin/analytics/top-vendors?from=${FROM}&to=${TO}&limit=50`);
    expect(res.status).toBe(200);
    const want = expectedLeaders(fx, range(FROM, TO)).vendors;
    expect(res.body.data.items.map((v) => without(v, 'shopName', 'shopSlug'))).toEqual(want);
    expect(res.body.data.items[0].shopName).toMatch(/^Shop \d$/);
    // Ranked list of ALL vendors adds up to the overview GMV.
    const gmv = res.body.data.items.reduce((n, v) => n + v.gmvPaise, 0);
    expect(gmv).toBe(expectedOverview(fx, range(FROM, TO)).gmvPaise);
  });

  it('top-products: ranked by revenue, cancelled sub-orders left out, limit honoured', async () => {
    const res = await get(`/admin/analytics/top-products?from=${FROM}&to=${TO}&limit=5`);
    expect(res.status).toBe(200);
    const want = expectedLeaders(fx, range(FROM, TO)).products.slice(0, 5);
    expect(res.body.data.items.map((v) => without(v, 'vendorId', 'shopName'))).toEqual(want);
    expect(res.body.data.items).toHaveLength(5);
  });

  it('without from/to the range is the last 30 UTC days, today included', async () => {
    const res = await get('/admin/analytics/overview');
    expect(res.status).toBe(200);
    const { from, to } = res.body.data.range;
    expect(to).toBe(new Date().toISOString().slice(0, 10)); // ends today (UTC)
    expect((Date.parse(to) - Date.parse(from)) / DAY).toBe(29); // 30 days, both ends inclusive
  });
});

describe('what counts, and the edges of the range', () => {
  beforeEach(async () => {
    await clearDb();
    app = buildTestApp();
    admin = await makeAdmin(app);
  });

  const order = (n, placedAt, overrides = {}) => ({
    orderNumber: `MP-20260901-${String(n).padStart(6, '0')}`,
    customerId: admin.id,
    status: 'placed',
    paymentStatus: 'paid',
    refundStatus: 'none',
    currency: 'INR',
    subtotalPaise: 1000,
    discountPaise: 0,
    shippingPaise: 0,
    totalPaise: 1000,
    idempotencyKey: `k-${n}`,
    placedAt: new Date(placedAt),
    createdAt: new Date(placedAt),
    updatedAt: new Date(placedAt),
    ...overrides,
  });

  it('counts the first and last millisecond of the range, not the day before or after', async () => {
    const { Order } = await import('../src/modules/orders/orders.model.js');
    await Order.collection.insertMany([
      order(1, '2026-09-09T23:59:59.999Z'), // one ms before
      order(2, '2026-09-10T00:00:00.000Z'), // first ms
      order(3, '2026-09-12T23:59:59.999Z'), // last ms
      order(4, '2026-09-13T00:00:00.000Z'), // one ms after
    ]);
    const res = await get('/admin/analytics/overview?from=2026-09-10&to=2026-09-12');
    expect(res.body.data).toMatchObject({ orderCount: 2, gmvPaise: 2000 });
    const series = await get('/admin/analytics/sales-timeseries?from=2026-09-10&to=2026-09-12');
    expect(series.body.data.points.map((p) => [p.bucket, p.orderCount])).toEqual([
      ['2026-09-10', 1],
      ['2026-09-11', 0],
      ['2026-09-12', 1],
    ]);
  });

  it('never counts an order that is not paid, however it is placed', async () => {
    const { Order } = await import('../src/modules/orders/orders.model.js');
    await Order.collection.insertMany([
      order(1, '2026-09-10T10:00:00Z'),
      order(2, '2026-09-10T10:00:00Z', { paymentStatus: 'unpaid', status: 'pending_payment' }),
      order(3, '2026-09-10T10:00:00Z', { paymentStatus: 'failed', status: 'expired' }),
    ]);
    const res = await get('/admin/analytics/overview?from=2026-09-10&to=2026-09-10');
    expect(res.body.data).toMatchObject({
      orderCount: 1,
      gmvPaise: 1000,
      averageOrderValuePaise: 1000,
    });
  });

  it('an empty range is all zeros, not an error', async () => {
    const res = await get('/admin/analytics/overview?from=2026-01-01&to=2026-01-31');
    expect(res.body.data).toMatchObject({
      orderCount: 0,
      gmvPaise: 0,
      commissionPaise: 0,
      netGmvPaise: 0,
      averageOrderValuePaise: 0,
    });
    const top = await get('/admin/analytics/top-vendors?from=2026-01-01&to=2026-01-31');
    expect(top.body.data.items).toEqual([]);
  });
});

describe('request validation (422) and access', () => {
  beforeAll(async () => {
    await clearDb();
    app = buildTestApp();
    admin = await makeAdmin(app);
  });

  it.each([
    ['/admin/analytics/overview?from=2026-9-1', 'a date that is not YYYY-MM-DD'],
    ['/admin/analytics/overview?from=2026-02-31', 'a date that does not exist'],
    ['/admin/analytics/overview?from=2026-10-02&to=2026-10-01', 'from after to'],
    ['/admin/analytics/overview?from=2025-01-01&to=2026-10-01', 'a range wider than 366 days'],
    ['/admin/analytics/sales-timeseries?interval=week', 'an unknown interval'],
    ['/admin/analytics/top-vendors?limit=51', 'a limit above 50'],
    ['/admin/analytics/top-products?limit=0', 'a limit of 0'],
  ])('%s -> 422 (%s)', async (path) => {
    const res = await get(path);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('is admin-only: anonymous 401, customer and vendor 403', async () => {
    expect((await request(app).get('/api/v1/admin/analytics/overview')).status).toBe(401);
    const vendor = await makeVendor(app, 'v-analytics@example.com');
    expect((await get('/admin/analytics/overview', vendor.auth)).status).toBe(403);
  });
});

describe('caching (D67)', () => {
  let redis;
  const sets = [];
  beforeEach(async () => {
    await clearDb();
    redis = createFakeRedis();
    sets.length = 0;
    const set = redis.set;
    redis.set = (...args) => {
      sets.push(args);
      return set(...args);
    };
    app = buildTestApp({ redis });
    admin = await makeAdmin(app);
  });

  it('serves the second identical request from the cache for 5 minutes (TTL only)', async () => {
    const { Order } = await import('../src/modules/orders/orders.model.js');
    const placed = new Date('2026-09-10T10:00:00Z');
    const doc = (n) => ({
      orderNumber: `MP-20260901-${String(n).padStart(6, '0')}`,
      customerId: admin.id,
      status: 'placed',
      paymentStatus: 'paid',
      currency: 'INR',
      totalPaise: 5000,
      idempotencyKey: `c-${n}`,
      placedAt: placed,
      createdAt: placed,
      updatedAt: placed,
    });
    await Order.collection.insertOne(doc(1));
    const path = '/admin/analytics/overview?from=2026-09-10&to=2026-09-10';
    const first = await get(path);
    expect(first.body.data).toMatchObject({ orderCount: 1, gmvPaise: 5000 });

    await Order.collection.insertOne(doc(2)); // a new order after the figures were cached
    const second = await get(path);
    expect(second.body.data).toEqual(first.body.data); // same entry, same generatedAt
    // A different range is a different entry and sees the new order.
    const other = await get('/admin/analytics/overview?from=2026-09-09&to=2026-09-10');
    expect(other.body.data.orderCount).toBe(2);

    const [key, , mode, ttl] = sets[0];
    expect(key).toMatch(/^cache:analytics:overview:[0-9a-f]{16}$/);
    expect([mode, ttl]).toEqual(['EX', 300]);
  });

  it('with Redis down it still answers 200 with fresh figures (fail-open)', async () => {
    redis.fail = true;
    const res = await get('/admin/analytics/overview?from=2026-09-10&to=2026-09-10');
    expect(res.status).toBe(200);
    expect(res.body.data.orderCount).toBe(0);
  });
});

describe('speed on 10,000 seeded orders (acceptance: each endpoint under 500 ms)', () => {
  beforeAll(async () => {
    await clearDb();
    app = buildTestApp(); // no Redis: every call runs the pipeline
    admin = await makeAdmin(app);
    const fx = buildFixtures({
      orders: 10_000,
      vendors: 20,
      products: 200,
      startMs: START,
      days: 90,
      seed: 3,
    });
    await insertFixtures(fx);
    const { Order } = await import('../src/modules/orders/orders.model.js');
    await Order.syncIndexes();
  }, 120_000);

  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const q = 'from=2026-09-01&to=2026-11-29'; // the whole 90 days

  it.each([
    ['overview', `/admin/analytics/overview?${q}`],
    ['sales-timeseries (day)', `/admin/analytics/sales-timeseries?${q}&interval=day`],
    ['top-vendors', `/admin/analytics/top-vendors?${q}`],
    ['top-products', `/admin/analytics/top-products?${q}`],
  ])(
    '%s',
    async (name, path) => {
      const times = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const res = await get(path);
        times.push(performance.now() - t0);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      }
      const m = median(times);
      console.log(
        `[perf] ${name}: median ${m.toFixed(0)} ms, max ${Math.max(...times).toFixed(0)} ms over 5 runs, 10,000 orders`,
      );
      expect(m).toBeLessThan(500);
    },
    60_000,
  );
});
