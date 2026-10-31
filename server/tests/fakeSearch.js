/**
 * In-memory stand-in for modules/search/search.index.js (same methods), so tests need no
 * Elasticsearch. It reproduces the two behaviours the app relies on: external_gte versioning
 * (an older version never overwrites a newer one) and an alias that can be moved atomically.
 * Real-ES behaviour is NOT covered by it: see HANDOVER "Not verified".
 */
export function createFakeSearchIndex() {
  const indices = new Map(); // name -> Map(id -> { version, deleted, doc })
  let aliasTarget = null;
  let counter = 0;
  const state = {
    down: false,
    failIds: new Set(),
    searchCalls: 0,
    bulkCalls: 0,
  };

  const guard = () => {
    if (state.down) throw new Error('connect ECONNREFUSED 127.0.0.1:9200');
  };
  const live = (name = aliasTarget) =>
    [...(indices.get(name) ?? new Map())].filter(([, v]) => !v.deleted);

  const fake = {
    state,
    alias: 'products',
    async ensureIndex() {
      guard();
      if (!aliasTarget) aliasTarget = await fake.createIndex();
    },
    async createIndex() {
      guard();
      const name = `products_v${++counter}`;
      indices.set(name, new Map());
      return name;
    },
    async bulk(ops, { index } = {}) {
      guard();
      state.bulkCalls += 1;
      const docs = indices.get(index ?? aliasTarget);
      const failed = [];
      for (const op of ops) {
        if (state.failIds.has(op.id)) {
          failed.push({ id: op.id, error: 'mapper_parsing_exception' });
          continue;
        }
        const current = docs.get(op.id);
        if (current && op.version < current.version) continue; // stale write: rejected, counts as ok
        docs.set(op.id, {
          version: op.version,
          deleted: op.op === 'delete',
          doc: op.op === 'index' ? op.doc : undefined,
        });
      }
      return { failed };
    },
    async refresh() {
      guard();
    },
    async swapAlias(newIndex) {
      guard();
      const old = aliasTarget && aliasTarget !== newIndex ? [aliasTarget] : [];
      aliasTarget = newIndex;
      return old;
    },
    async deleteIndex(name) {
      indices.delete(name);
    },
    async search(params) {
      guard();
      state.searchCalls += 1;
      const q = params.q?.toLowerCase();
      let hits = live().map(([id, { doc }]) => ({ id, ...doc }));
      hits = hits.filter(
        (h) =>
          (!q || `${h.title} ${h.description}`.toLowerCase().includes(q)) &&
          (!params.categoryId || h.categoryIds.includes(params.categoryId)) &&
          (!params.vendor || h.shopSlug === params.vendor) &&
          (params.minPrice === undefined || h.pricePaise >= params.minPrice) &&
          (params.maxPrice === undefined || h.pricePaise <= params.maxPrice) &&
          (params.minRating === undefined || h.ratingAvg >= params.minRating) &&
          (!params.inStock || h.inStock),
      );
      const by =
        {
          price: (a, b) => a.pricePaise - b.pricePaise,
          '-price': (a, b) => b.pricePaise - a.pricePaise,
          '-ratingAvg': (a, b) => b.ratingAvg - a.ratingAvg,
        }[params.sort] ?? ((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      hits.sort((a, b) => by(a, b) || a.slug.localeCompare(b.slug));
      const from = (params.page - 1) * params.limit;
      return {
        items: hits.slice(from, from + params.limit),
        total: hits.length,
      };
    },
    // --- inspection helpers for tests ---
    liveIds: (name) =>
      live(name)
        .map(([id]) => id)
        .sort(),
    indexNames: () => [...indices.keys()],
    get currentIndex() {
      return aliasTarget;
    },
  };
  return fake;
}

/** Minimal ioredis stand-in for the cache (get / set ... EX / del). Can be switched to fail. */
export function createFakeRedis() {
  const store = new Map();
  const redis = {
    store,
    fail: false,
    gets: 0,
    async get(key) {
      redis.gets += 1;
      if (redis.fail) throw new Error('Connection is closed.');
      return store.get(key) ?? null;
    },
    async set(key, value) {
      if (redis.fail) throw new Error('Connection is closed.');
      store.set(key, value);
      return 'OK';
    },
    async del(...keys) {
      if (redis.fail) throw new Error('Connection is closed.');
      for (const key of keys) store.delete(key);
      return keys.length;
    },
  };
  return redis;
}