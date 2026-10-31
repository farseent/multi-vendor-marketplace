import { describe, expect, it, vi } from 'vitest';
import { createCache } from '../src/lib/cache.js';
import { buildEsRequest } from '../src/modules/search/search.query.js';
import { createSearchIndex } from '../src/modules/search/search.index.js';
import { searchQuery } from '../src/modules/search/search.validator.js';
import { createFakeRedis } from './fakeSearch.js';
import { silentLogger } from './helpers.js';

const base = { sort: 'relevance', page: 1, limit: 20 };

describe('buildEsRequest', () => {
  it('without q or filters: match_all, newest first, deterministic tie-break', () => {
    const body = buildEsRequest(base);
    expect(body.query.bool.must).toEqual([{ match_all: {} }]);
    expect(body.query.bool.filter).toEqual([]);
    expect(body.sort).toEqual([{ createdAt: 'desc' }, { slug: 'asc' }]);
    expect(body).toMatchObject({ from: 0, size: 20, track_total_hits: true });
  });

  it('text query: fuzzy multi_match with title boost, sorted by score', () => {
    const body = buildEsRequest({ ...base, q: 'kurta' });
    expect(body.query.bool.must[0].multi_match).toMatchObject({
      query: 'kurta',
      fields: ['title^3', 'description'],
      fuzziness: 'AUTO',
    });
    expect(body.sort[0]).toEqual({ _score: 'desc' });
  });

  it('maps every filter, and offsets pagination', () => {
    const body = buildEsRequest({
      ...base,
      categoryId: 'c1',
      vendor: 'loom-co',
      minPrice: 100,
      maxPrice: 900,
      minRating: 4,
      inStock: true,
      sort: '-price',
      page: 3,
      limit: 10,
    });
    expect(body.query.bool.filter).toEqual([
      { term: { categoryIds: 'c1' } },
      { term: { shopSlug: 'loom-co' } },
      { range: { pricePaise: { gte: 100, lte: 900 } } },
      { range: { ratingAvg: { gte: 4 } } },
      { term: { inStock: true } },
    ]);
    expect(body.sort[0]).toEqual({ pricePaise: 'desc' });
    expect(body).toMatchObject({ from: 20, size: 10 });
  });

  it('a price range with only one bound has only that bound; inStock=false adds no filter', () => {
    const body = buildEsRequest({ ...base, minPrice: 500, inStock: false });
    expect(body.query.bool.filter).toEqual([{ range: { pricePaise: { gte: 500 } } }]);
  });
});

describe('searchQuery validation', () => {
  const parse = (query) => searchQuery.safeParse(query);

  it('applies defaults and coerces numbers/booleans', () => {
    const r = parse({ minPrice: '50000', inStock: 'true', minRating: '4.5' });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({
      minPrice: 50000,
      inStock: true,
      minRating: 4.5,
      sort: 'relevance',
      page: 1,
      limit: 20,
    });
  });

  it('treats empty strings as "not given" (not as 0)', () => {
    const r = parse({ q: '  ', minPrice: '', maxPrice: '', inStock: '' });
    expect(r.success).toBe(true);
    expect(r.data.q).toBeUndefined();
    expect(r.data.minPrice).toBeUndefined();
  });

  it.each([
    [{ sort: 'cheapest' }],
    [{ limit: '101' }],
    [{ page: '0' }],
    [{ minPrice: '-1' }],
    [{ minPrice: '1.5' }],
    [{ minPrice: '900', maxPrice: '100' }],
    [{ minRating: '6' }],
    [{ categoryId: 'nope' }],
    [{ vendor: 'Bad Slug!' }],
    [{ q: 'x'.repeat(101) }],
    [{ page: '101', limit: '100' }], // beyond the 10,000-result window
    [{ q: ['a', 'b'] }], // repeated parameter
  ])('rejects %j', (query) => {
    expect(parse(query).success).toBe(false);
  });
});

describe('createCache (fail-open)', () => {
  it('round-trips JSON', async () => {
    const cache = createCache({
      redis: createFakeRedis(),
      logger: silentLogger,
    });
    await cache.setJson('k', { a: 1 }, 60);
    expect(await cache.getJson('k')).toEqual({ a: 1 });
    await cache.del('k');
    expect(await cache.getJson('k')).toBeNull();
  });

  it('is a no-op without Redis', async () => {
    const cache = createCache({ redis: null, logger: silentLogger });
    await cache.setJson('k', 1, 60);
    expect(await cache.getJson('k')).toBeNull();
    await expect(cache.del('k')).resolves.toBeUndefined();
  });

  it('never throws when Redis fails; logs at warn', async () => {
    const redis = createFakeRedis();
    redis.fail = true;
    const logger = { warn: vi.fn() };
    const cache = createCache({ redis, logger });
    expect(await cache.getJson('k')).toBeNull();
    await expect(cache.setJson('k', 1, 60)).resolves.toBeUndefined();
    await expect(cache.del('k')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1); // throttled: one line, not three
  });

  it('after a failure it skips Redis for reads/writes (no repeated 100 ms waits) but still tries deletes', async () => {
    const redis = createFakeRedis();
    redis.fail = true;
    const cache = createCache({ redis, logger: { warn: vi.fn() } });
    await cache.getJson('k'); // trips the breaker
    redis.fail = false;
    redis.gets = 0;
    await cache.getJson('k');
    await cache.setJson('k', 1, 60);
    expect(redis.gets).toBe(0);
    expect(redis.store.size).toBe(0); // set was skipped too
    redis.store.set('stale', '1');
    await cache.del('stale');
    expect(redis.store.has('stale')).toBe(false); // invalidation still goes through
  });

  it('treats a hung Redis as a miss after ~100 ms', async () => {
    const redis = { get: () => new Promise(() => {}) };
    const cache = createCache({ redis, logger: { warn: vi.fn() } });
    const started = Date.now();
    expect(await cache.getJson('k')).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('treats corrupt cached JSON as a miss', async () => {
    const redis = createFakeRedis();
    redis.store.set('k', '{not json');
    const cache = createCache({ redis, logger: { warn: vi.fn() } });
    expect(await cache.getJson('k')).toBeNull();
  });
});

describe('createSearchIndex adapter (mock ES client)', () => {
  const clientWith = (overrides) => ({
    indices: {},
    ...overrides,
  });

  it('bulk: external_gte versions; conflicts and missing deletes count as success', async () => {
    const bulk = vi.fn().mockResolvedValue({
      items: [
        { index: { status: 201 } },
        {
          index: {
            status: 409,
            error: { type: 'version_conflict_engine_exception' },
          },
        },
        { delete: { status: 404 } },
        { index: { status: 400, error: { type: 'mapper_parsing_exception' } } },
      ],
    });
    const index = createSearchIndex({ client: clientWith({ bulk }) });
    const res = await index.bulk([
      { op: 'index', id: 'a', version: 5, doc: { title: 'A' } },
      { op: 'index', id: 'b', version: 1, doc: { title: 'B' } },
      { op: 'delete', id: 'c', version: 7 },
      { op: 'index', id: 'd', version: 2, doc: { title: 'D' } },
    ]);
    expect(res.failed).toEqual([{ id: 'd', error: 'mapper_parsing_exception' }]);
    const { operations } = bulk.mock.calls[0][0];
    expect(operations[0]).toEqual({
      index: {
        _index: 'products',
        _id: 'a',
        version: 5,
        version_type: 'external_gte',
      },
    });
    expect(operations[4]).toEqual({
      delete: {
        _index: 'products',
        _id: 'c',
        version: 7,
        version_type: 'external_gte',
      },
    });
  });

  it('bulk: a failing request (ES down) throws instead of reporting per-item failures', async () => {
    const bulk = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const index = createSearchIndex({ client: clientWith({ bulk }) });
    await expect(index.bulk([{ op: 'delete', id: 'x', version: 1 }])).rejects.toThrow(
      'ECONNREFUSED',
    );
  });

  it('bulk with no operations makes no request', async () => {
    const bulk = vi.fn();
    await createSearchIndex({ client: clientWith({ bulk }) }).bulk([]);
    expect(bulk).not.toHaveBeenCalled();
  });

  it('search maps hits and total', async () => {
    const search = vi.fn().mockResolvedValue({
      hits: {
        total: { value: 37 },
        hits: [{ _id: 'p1', _source: { title: 'T', slug: 's' } }],
      },
    });
    const index = createSearchIndex({ client: clientWith({ search }) });
    const res = await index.search({ sort: 'relevance', page: 1, limit: 2 });
    expect(res).toEqual({
      items: [{ id: 'p1', title: 'T', slug: 's' }],
      total: 37,
    });
    expect(search.mock.calls[0][0].index).toBe('products');
  });

  it('ensureIndex creates index + alias only when the alias is missing', async () => {
    const create = vi.fn().mockResolvedValue({});
    const putAlias = vi.fn().mockResolvedValue({});
    const getAlias = vi.fn().mockRejectedValue({ meta: { statusCode: 404 } });
    const index = createSearchIndex({
      client: clientWith({ indices: { getAlias, create, putAlias } }),
    });
    await index.ensureIndex();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].mappings.dynamic).toBe('strict');
    expect(putAlias).toHaveBeenCalledWith(expect.objectContaining({ name: 'products' }));

    getAlias.mockResolvedValue({ products_v1: {} });
    await index.ensureIndex();
    expect(create).toHaveBeenCalledTimes(1); // unchanged
  });

  it('ensureIndex tolerates losing the boot race (index already exists) and still attaches the alias', async () => {
    const create = vi.fn().mockRejectedValue({
      meta: { body: { error: { type: 'resource_already_exists_exception' } } },
    });
    const putAlias = vi.fn().mockResolvedValue({});
    const getAlias = vi.fn().mockRejectedValue({ meta: { statusCode: 404 } });
    const index = createSearchIndex({
      client: clientWith({ indices: { getAlias, create, putAlias } }),
    });
    await expect(index.ensureIndex()).resolves.toBeUndefined();
    expect(create.mock.calls[0][0].index).toBe('products_v0'); // fixed name, same for every instance
    expect(putAlias).toHaveBeenCalledWith({ index: 'products_v0', name: 'products' });
  });

  it('ensureIndex still fails on other Elasticsearch errors', async () => {
    const create = vi.fn().mockRejectedValue(new Error('cluster_block_exception'));
    const getAlias = vi.fn().mockRejectedValue({ meta: { statusCode: 404 } });
    const index = createSearchIndex({ client: clientWith({ indices: { getAlias, create } }) });
    await expect(index.ensureIndex()).rejects.toThrow('cluster_block_exception');
  });

  it('swapAlias removes the old indices and adds the new one in ONE atomic call', async () => {
    const updateAliases = vi.fn().mockResolvedValue({});
    const getAlias = vi.fn().mockResolvedValue({ products_v1: {} });
    const index = createSearchIndex({
      client: clientWith({ indices: { getAlias, updateAliases } }),
    });
    const old = await index.swapAlias('products_v2');
    expect(old).toEqual(['products_v1']);
    expect(updateAliases).toHaveBeenCalledTimes(1);
    expect(updateAliases.mock.calls[0][0].actions).toEqual([
      { remove: { index: 'products_v1', alias: 'products' } },
      { add: { index: 'products_v2', alias: 'products' } },
    ]);
  });
});
