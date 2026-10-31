import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEARCH_SYNC } from '../src/config/constants.js';
import { createJobLocks } from '../src/jobs/jobLock.js';
import { createSearchSyncJob } from '../src/jobs/searchSync.js';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { Category } from '../src/modules/catalog/categories.model.js';
import { Product } from '../src/modules/catalog/products.model.js';
import { SearchOutbox } from '../src/modules/search/search.model.js';
import { Vendor } from '../src/modules/shops/shops.model.js';
import { clearDb, startTestDb, stopTestDb } from './db.js';
import { createFakeRedis, createFakeSearchIndex } from './fakeSearch.js';
import { makeAdmin, makeCategory, makeVendor, productBody } from './factories.js';
import { buildTestApp, silentLogger } from './helpers.js';

let replSet;
let app;
let es;
let redis;
let job;
let sku = 0;

beforeAll(async () => {
  replSet = await startTestDb();
}, 60_000);
afterAll(() => stopTestDb(replSet));

beforeEach(async () => {
  await clearDb();
  vi.restoreAllMocks();
  es = createFakeSearchIndex();
  redis = createFakeRedis();
  app = buildTestApp({ searchIndex: es, redis });
  job = makeJob(es);
});

// Fast back-offs and a tiny attempt budget so failure paths run in milliseconds.
const makeJob = (searchIndex, config = {}) =>
  createSearchSyncJob({
    searchIndex,
    jobLocks: createJobLocks(),
    logger: silentLogger,
    config: {
      ...SEARCH_SYNC,
      outageBackoffMs: { min: 1, max: 1 },
      maxAttempts: 3,
      ...config,
    },
  });

const api = (method, path, auth, body) => {
  const req = request(app)
    [method](`/api/v1${path}`)
    .set(auth ?? {});
  return body === undefined ? req : req.send(body);
};

/** Approved shop + category + helper to publish products through the real API. */
async function seed(email = 'v1@example.com') {
  const vendor = await makeVendor(app, email, {
    approved: true,
    shopName: 'Loom and Co',
  });
  const category = await makeCategory();
  const add = async (overrides = {}) => {
    const res = await api(
      'post',
      '/vendor/products',
      vendor.auth,
      productBody(vendor.shop.id, category.id, {
        status: 'active',
        sku: `SKU-${++sku}`,
        ...overrides,
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data;
  };
  return { vendor, category, add };
}
const search = (query = '') => api('get', `/products/search${query}`);

describe('route registration', () => {
  it('/products/search is not swallowed by /products/:slug', async () => {
    const res = await search();
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 20, total: 0 });
  });

  it('rejects invalid parameters with 422 before touching ES or Mongo', async () => {
    for (const q of ['?sort=cheapest', '?limit=101', '?minPrice=900&maxPrice=100', '?page=0']) {
      const res = await search(q);
      expect(res.status, q).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(es.state.searchCalls).toBe(0);
  });
});

describe('outbox: written in the same transaction as the product write', () => {
  it('create active -> 1 entry; create draft -> none', async () => {
    const { add } = await seed();
    await add({ status: 'draft' });
    expect(await SearchOutbox.countDocuments()).toBe(0);
    const p = await add();
    const entries = await SearchOutbox.find();
    expect(entries).toHaveLength(1);
    expect(String(entries[0].productId)).toBe(p.id);
  });

  it('update, archive and status change each enqueue', async () => {
    const { vendor, add } = await seed();
    const p = await add();
    await SearchOutbox.deleteMany({});
    await api('patch', `/vendor/products/${p.id}`, vendor.auth, {
      pricePaise: 99900,
    });
    expect(await SearchOutbox.countDocuments()).toBe(1);
    await api('delete', `/vendor/products/${p.id}`, vendor.auth);
    expect(await SearchOutbox.countDocuments()).toBe(2);
  });

  it('stock enqueues only when it crosses zero', async () => {
    const { vendor, add } = await seed();
    const p = await add({ stockQty: 25 });
    await SearchOutbox.deleteMany({});
    const set = (stockQty) =>
      api('patch', `/vendor/products/${p.id}/stock`, vendor.auth, { stockQty });
    await set(10); // 25 -> 10: still in stock
    expect(await SearchOutbox.countDocuments()).toBe(0);
    await set(0); // -> out of stock
    expect(await SearchOutbox.countDocuments()).toBe(1);
    await set(0); // no change
    expect(await SearchOutbox.countDocuments()).toBe(1);
    await set(5); // back in stock
    expect(await SearchOutbox.countDocuments()).toBe(2);
  });

  it('rolls the product back when the outbox write fails (one transaction)', async () => {
    const { vendor, category } = await seed();
    vi.spyOn(SearchOutbox, 'insertMany').mockRejectedValueOnce(new Error('boom'));
    const res = await api(
      'post',
      '/vendor/products',
      vendor.auth,
      productBody(vendor.shop.id, category.id, {
        status: 'active',
        sku: 'ROLLBACK-1',
      }),
    );
    expect(res.status).toBe(500);
    expect(await Product.countDocuments()).toBe(0);
    expect(await SearchOutbox.countDocuments()).toBe(0);
  });
});

describe('sync job: outbox -> index', () => {
  it('indexes public fields only, drains the outbox, and search returns the product', async () => {
    const { add } = await seed();
    const p = await add({ title: 'Handloom Cotton Kurta', stockQty: 3 });
    await job.tick();

    expect(await SearchOutbox.countDocuments()).toBe(0);
    expect(es.liveIds()).toEqual([p.id]);

    const res = await search('?q=kurta');
    expect(res.status).toBe(200);
    expect(res.headers['x-search-fallback']).toBeUndefined();
    expect(res.body.data).toEqual([
      {
        id: p.id,
        slug: p.slug,
        title: 'Handloom Cotton Kurta',
        pricePaise: 149900,
        imageUrl: expect.stringMatching(/^https:\/\/cdn\.test\/products\//),
        ratingAvg: 0,
        ratingCount: 0,
        shop: { name: 'Loom and Co', slug: 'loom-and-co' },
        inStock: true,
      },
    ]);
  });

  it('never puts private fields in the index document', async () => {
    const { add } = await seed();
    await add({ sku: 'SECRET-SKU', stockQty: 77 });
    let captured;
    const bulk = es.bulk.bind(es);
    es.bulk = async (ops, opts) => {
      captured = ops;
      return bulk(ops, opts);
    };
    await job.tick();
    const doc = captured[0].doc;
    expect(JSON.stringify(doc)).not.toMatch(/SECRET-SKU|stockQty|vendorId|"sku"/);
    expect(doc.inStock).toBe(true);
  });

  it('archiving removes the product from search', async () => {
    const { vendor, add } = await seed();
    const p = await add();
    await job.tick();
    expect(es.liveIds()).toHaveLength(1);
    await api('delete', `/vendor/products/${p.id}`, vendor.auth);
    await job.tick();
    expect(es.liveIds()).toHaveLength(0);
    expect((await search()).body.data).toHaveLength(0);
  });

  it('out of stock flips inStock and the inStock filter hides it', async () => {
    const { vendor, add } = await seed();
    const p = await add();
    await job.tick();
    await api('patch', `/vendor/products/${p.id}/stock`, vendor.auth, {
      stockQty: 0,
    });
    await job.tick();
    redis.store.clear(); // search results are cached for 60 s; start clean
    expect((await search()).body.data[0].inStock).toBe(false);
    expect((await search('?inStock=true')).body.data).toHaveLength(0);
  });

  it('suspending a vendor de-indexes all its products; re-approving restores them (versioning)', async () => {
    const { add, vendor } = await seed();
    await add();
    await add();
    await job.tick();
    expect(es.liveIds()).toHaveLength(2);

    const admin = await makeAdmin(app);
    const setStatus = (status) =>
      api('patch', `/admin/vendors/${vendor.shop.id}/status`, admin.auth, {
        status,
      });

    expect((await setStatus('suspended')).status).toBe(200);
    expect(await SearchOutbox.countDocuments()).toBe(2); // enqueued in the status transaction
    await job.tick();
    expect(es.liveIds()).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 5)); // distinct millisecond for the version
    expect((await setStatus('approved')).status).toBe(200);
    await job.tick();
    expect(es.liveIds()).toHaveLength(2);
  });

  it('a shop rename re-syncs its products', async () => {
    const { vendor, add } = await seed();
    await add();
    await job.tick();
    await api('patch', '/vendor/profile', vendor.auth, {
      shopName: 'Renamed Shop',
    });
    expect(await SearchOutbox.countDocuments()).toBe(1);
    await job.tick();
    redis.store.clear();
    expect((await search()).body.data[0].shop.name).toBe('Renamed Shop');
  });

  it('per-document failures raise attempts with back-off and flag the entry at the limit', async () => {
    const { add } = await seed();
    const p = await add();
    es.state.failIds.add(p.id);

    await job.tick();
    let entry = await SearchOutbox.findOne();
    expect(entry.attempts).toBe(1);
    expect(entry.lastError).toBe('mapper_parsing_exception');
    expect(entry.nextAttemptAt.getTime()).toBeGreaterThan(Date.now()); // backing off

    // Fast-forward its back-off, exhaust the budget (maxAttempts = 3 in these tests).
    for (let i = 0; i < 3; i++) {
      await SearchOutbox.updateOne({}, { nextAttemptAt: new Date(0) });
      await job.tick();
    }
    entry = await SearchOutbox.findOne();
    expect(entry.attempts).toBe(3);

    // Flagged: no longer claimed, still stored for an admin.
    es.state.failIds.clear();
    await SearchOutbox.updateOne({}, { nextAttemptAt: new Date(0) });
    await job.tick();
    expect(await SearchOutbox.countDocuments()).toBe(1);
  });

  it('does nothing while another instance holds the lease', async () => {
    const { add } = await seed();
    await add();
    const locks = createJobLocks();
    expect(await locks.acquire(SEARCH_SYNC.jobName, 'other-instance', 60_000)).toBe(true);
    expect(await job.tick()).toEqual({ skipped: true });
    expect(await SearchOutbox.countDocuments()).toBe(1);
    await locks.release(SEARCH_SYNC.jobName, 'other-instance');
    expect(await job.tick()).toMatchObject({ processed: 1 });
  });
});

describe('Elasticsearch outage', () => {
  it('search still answers 200 from Mongo with X-Search-Fallback; sync drains after recovery', async () => {
    const { add } = await seed();
    await add({ title: 'Handloom Cotton Kurta', pricePaise: 149900 });
    await add({ title: 'Silk Saree', sku: 'SAREE-1', pricePaise: 999900 });
    await add({ title: 'Draft Kurta', status: 'draft', sku: 'DRAFT-1' });
    await job.tick();
    redis.store.clear();

    es.state.down = true;
    const res = await search('?q=kurta');
    expect(res.status).toBe(200);
    expect(res.headers['x-search-fallback']).toBe('mongo');
    expect(res.body.data.map((p) => p.title)).toEqual(['Handloom Cotton Kurta']); // not the draft
    expect(res.body.data[0]).toHaveProperty('shop.slug', 'loom-and-co');

    // Filters and sorts work in the fallback too.
    const cheap = await search('?maxPrice=200000&sort=price');
    expect(cheap.headers['x-search-fallback']).toBe('mongo');
    expect(cheap.body.data.map((p) => p.title)).toEqual(['Handloom Cotton Kurta']);

    // Writes made during the outage queue up, and the job backs off without burning attempts.
    await add({ title: 'Outage Product', sku: 'OUT-1' });
    expect(await job.tick()).toEqual({ paused: true });
    expect((await SearchOutbox.findOne()).attempts).toBe(0);
    expect(await SearchOutbox.countDocuments()).toBe(1);

    es.state.down = false;
    await new Promise((r) => setTimeout(r, 10)); // outage back-off is 1 ms in tests
    await job.tick();
    expect(await SearchOutbox.countDocuments()).toBe(0);
    expect(es.liveIds()).toHaveLength(3);
  });

  it('fallback is never served from, or written to, the cache', async () => {
    const { add } = await seed();
    await add();
    es.state.down = true;
    await search();
    expect([...redis.store.keys()].some((k) => k.startsWith('cache:search:'))).toBe(false);
  });

  it('without any search index configured, search uses the fallback', async () => {
    app = buildTestApp({ searchIndex: null });
    const { add } = await seed();
    await add();
    const res = await search();
    expect(res.headers['x-search-fallback']).toBe('mongo');
    expect(res.body.data).toHaveLength(1);
  });

  it('fallback hides products of suspended shops and honours category, vendor and rating filters', async () => {
    app = buildTestApp({ searchIndex: null });
    const a = await seed('a@example.com');
    const parent = await Category.create({ name: 'Apparel', slug: 'apparel' });
    const child = await Category.create({
      name: 'Kurtas',
      slug: 'kurtas',
      parentId: parent._id,
    });
    await a.add({ categoryId: String(child.id) });
    const b = await seed('b@example.com');
    await b.add();
    await Vendor.updateOne({ _id: b.vendor.shop.id }, { status: 'suspended', shopSlug: 'shop-b' });

    const all = await search();
    expect(all.body.data).toHaveLength(1);
    expect((await search(`?categoryId=${parent.id}`)).body.data).toHaveLength(1); // via child
    expect((await search(`?categoryId=${a.category.id}`)).body.data).toHaveLength(0);
    expect((await search('?vendor=shop-b')).body.data).toHaveLength(0);
    expect((await search('?minRating=4')).body.data).toHaveLength(0);
  });
});

describe('search filters and pagination (via the index path)', () => {
  it('filters by price, vendor and category; sorts; paginates with correct meta', async () => {
    const s = await seed();
    for (let i = 1; i <= 5; i++) {
      await s.add({ title: `Kurta number ${i}`, pricePaise: i * 100_00 });
    }
    await job.tick();

    const page1 = await search('?q=kurta&sort=price&page=1&limit=2');
    expect(page1.body.data.map((p) => p.pricePaise)).toEqual([10000, 20000]);
    expect(page1.body.meta).toEqual({
      page: 1,
      limit: 2,
      total: 5,
      totalPages: 3,
    });
    const page3 = await search('?q=kurta&sort=price&page=3&limit=2');
    expect(page3.body.data.map((p) => p.pricePaise)).toEqual([50000]);

    expect(
      (await search('?minPrice=20000&maxPrice=40000&sort=-price')).body.data.map(
        (p) => p.pricePaise,
      ),
    ).toEqual([40000, 30000, 20000]);
    expect((await search('?vendor=loom-and-co')).body.meta.total).toBe(5);
    expect((await search('?vendor=someone-else')).body.meta.total).toBe(0);
    expect((await search(`?categoryId=${s.category.id}`)).body.meta.total).toBe(5);
  });

  it('a page past the end is an empty list, not an error', async () => {
    const res = await search('?page=50');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('Redis cache', () => {
  it('product detail is cached, and an update invalidates it (next GET shows the new price)', async () => {
    const { vendor, add } = await seed();
    const p = await add({ pricePaise: 149900 });
    const spy = vi.spyOn(Product, 'findOne');

    const first = await api('get', `/products/${p.slug}`);
    const second = await api('get', `/products/${p.slug}`);
    expect(first.body.data.pricePaise).toBe(149900);
    expect(second.body).toEqual(first.body);
    expect(spy).toHaveBeenCalledTimes(1); // second answer came from Redis
    expect(redis.store.has(`cache:product:${p.slug}`)).toBe(true);

    await api('patch', `/vendor/products/${p.id}`, vendor.auth, {
      pricePaise: 129900,
    });
    expect(redis.store.has(`cache:product:${p.slug}`)).toBe(false);
    expect((await api('get', `/products/${p.slug}`)).body.data.pricePaise).toBe(129900);
  });

  it('stock changes, archiving and shop suspension all drop the cached page', async () => {
    const { vendor, add } = await seed();
    const p = await add();
    const key = `cache:product:${p.slug}`;
    const warm = () => api('get', `/products/${p.slug}`);

    await warm();
    await api('patch', `/vendor/products/${p.id}/stock`, vendor.auth, {
      stockQty: 0,
    });
    expect(redis.store.has(key)).toBe(false);
    expect((await warm()).body.data.inStock).toBe(false);

    const admin = await makeAdmin(app);
    await api('patch', `/admin/vendors/${vendor.shop.id}/status`, admin.auth, {
      status: 'suspended',
    });
    expect(redis.store.has(key)).toBe(false);
    expect((await warm()).status).toBe(404); // vanishes immediately, not after the 5 min TTL
  });

  it('misses (404) are not cached', async () => {
    await api('get', '/products/nope-1234');
    expect(redis.store.size).toBe(0);
  });

  it('category tree is cached and cleared on admin create/update', async () => {
    const admin = await makeAdmin(app);
    await api('post', '/admin/categories', admin.auth, { name: 'Clothing' });
    expect((await api('get', '/categories')).body.data).toHaveLength(1);
    expect(redis.store.has('cache:categories')).toBe(true);

    const spy = vi.spyOn(Category, 'find');
    await api('get', '/categories');
    expect(spy).not.toHaveBeenCalled(); // served from Redis

    const created = await api('post', '/admin/categories', admin.auth, {
      name: 'Home',
    });
    expect(redis.store.has('cache:categories')).toBe(false);
    expect((await api('get', '/categories')).body.data).toHaveLength(2);

    await api('patch', `/admin/categories/${created.body.data.id}`, admin.auth, {
      isActive: false,
    });
    expect((await api('get', '/categories')).body.data).toHaveLength(1);
  });

  it('identical searches share one cached answer (parameter order does not matter)', async () => {
    const { add } = await seed();
    await add();
    await job.tick();
    await search('?q=kurta&sort=price');
    await search('?sort=price&q=kurta');
    expect(es.state.searchCalls).toBe(1);
  });

  it('Redis down: product detail, categories and search still return 200; warning logged', async () => {
    const warn = vi.spyOn(silentLogger, 'warn');
    const { add } = await seed();
    const p = await add();
    await job.tick();
    redis.fail = true;

    expect((await api('get', `/products/${p.slug}`)).status).toBe(200);
    expect((await api('get', '/categories')).status).toBe(200);
    const res = await search('?q=kurta');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ op: expect.any(String) }),
      expect.stringContaining('Cache unavailable'),
    );
  });

  it('writes still succeed when Redis is down (invalidation failure is tolerated)', async () => {
    const { vendor, add } = await seed();
    const p = await add();
    redis.fail = true;
    const res = await api('patch', `/vendor/products/${p.id}`, vendor.auth, {
      pricePaise: 120000,
    });
    expect(res.status).toBe(200);
  });
});

describe('rate limit', () => {
  it('61st search request within a minute from one IP -> 429 with Retry-After', async () => {
    let last;
    for (let i = 0; i < 61; i++) last = await search();
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe('RATE_LIMITED');
    expect(last.headers['retry-after']).toBeDefined();
  });
});

describe('POST /admin/search/reindex', () => {
  it('rebuilds behind the alias, indexes only public products, drops the old index, audits', async () => {
    const s = await seed();
    const p1 = await s.add();
    const p2 = await s.add();
    await s.add({ status: 'draft', sku: 'D-1' });
    await job.tick();
    const oldIndex = es.currentIndex;

    // Index drift to be repaired: a stale doc for a product that is no longer public.
    await Product.updateOne({ _id: p2.id }, { status: 'archived' });

    const admin = await makeAdmin(app);
    const res = await api('post', '/admin/search/reindex', admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ indexed: 1 });
    expect(es.currentIndex).not.toBe(oldIndex);
    expect(es.indexNames()).toEqual([es.currentIndex]); // old index removed
    expect(es.liveIds()).toEqual([p1.id]);

    const audit = await AuditLog.findOne({ action: 'search.reindexed' });
    expect(audit).toBeTruthy();
  });

  it('keeps the old index when the rebuild fails', async () => {
    const s = await seed();
    await s.add();
    await job.tick();
    const oldIndex = es.currentIndex;
    es.state.failIds.add((await Product.findOne())._id.toString());
    const admin = await makeAdmin(app);
    const res = await api('post', '/admin/search/reindex', admin.auth);
    expect(res.status).toBe(503);
    expect(es.currentIndex).toBe(oldIndex);
    expect(es.indexNames()).toEqual([oldIndex]); // the half-built index was cleaned up
  });

  it('answers 503 when search is not configured', async () => {
    app = buildTestApp({ searchIndex: null });
    const admin = await makeAdmin(app);
    expect((await api('post', '/admin/search/reindex', admin.auth)).status).toBe(503);
  });

  it('flagged outbox entries older than the reindex are cleared by it', async () => {
    const s = await seed();
    const p = await s.add();
    await SearchOutbox.updateOne({ productId: p.id }, { attempts: SEARCH_SYNC.maxAttempts });
    const admin = await makeAdmin(app);
    await api('post', '/admin/search/reindex', admin.auth);
    expect(await SearchOutbox.countDocuments()).toBe(0);
    expect(es.liveIds()).toEqual([p.id]);
  });

  it('is admin-only', async () => {
    const vendor = await makeVendor(app, 'x@example.com');
    expect((await api('post', '/admin/search/reindex', vendor.auth)).status).toBe(403);
    expect((await api('post', '/admin/search/reindex')).status).toBe(401);
  });
});
