# HANDOVER.md

## Current state (after Phase 3: Search + caching)

Phase 3 is implemented. Branch suggestion: `phase-3-search-caching`. No Phase 4+ code exists. Phases 1-2 behave as before, except that product and shop writes now run inside Mongo transactions (see "Key decisions").

- **Search endpoint:** `GET /products/search` (public, 60/min/IP) with `q, categoryId, vendor, minPrice, maxPrice, minRating, inStock, sort, page, limit`. Prices are integer paise. `page x limit` is capped at 10,000 (Elasticsearch result window), otherwise 422. Registered above `/products/:slug` in `products.routes.js`.
- **Elasticsearch index:** alias `products` over concrete indices `products_v0` (first boot) / `products_v<timestamp>` (after reindex). Strict mapping; only public fields are indexed (no `stockQty`, `sku`, `vendorId`). Only `active` products of `approved` shops are indexed.
- **Outbox sync:** every product create-as-active / update / archive / stock-crossing-zero and every shop status change or rename writes `searchOutbox` entries in the SAME Mongo transaction as the write. `jobs/searchSync.js` (every 2 s, lease `jobLocks._id='searchSync'`) re-reads the product, bulk-applies index/delete with external versioning, then deletes the entries.
- **Mongo fallback:** if ES is down or not configured, search answers 200 from a Mongo `$text` query (same filters/sorts, no fuzziness) with header `X-Search-Fallback: mongo`. Fallback answers are never cached.
- **Reindex:** `npm run reindex` (root or `-w server`) and `POST /admin/search/reindex` (admin, audited as `search.reindexed`). Builds a new index, bulk loads, atomically swaps the alias, deletes the old index. The sync job pauses during it (same lease).
- **Redis cache (fail-open, 100 ms timeout, warn logs, 5 s circuit breaker for reads/writes):** `cache:product:{slug}` 5 min, `cache:categories` 1 h, `cache:search:{hash}` 60 s. Product keys are deleted on product update/archive/stock change and on shop status change/rename (all that shop's products). Category key is deleted on admin category create/update. Search results: TTL only.
- **Client:** `/search` page (URL holds filters; prices typed in rupees, sent as paise), header search box, home page link.

## Key decisions (proposed additions to DECISIONS.md)

- **D33 Product and shop writes run in transactions with the outbox entry** (replaces the Phase 2 plain saves). Mongo must be a replica set (already required).
- **D34 The sync job re-reads current state; the outbox entry only means "look at this product again".** `op` is stored for humans. Replays are idempotent.
- **D35 Index version = max(product.updatedAt, shop.updatedAt) in ms, `version_type=external_gte`.** (ARCHITECTURE said product.updatedAt only.) A product's visibility depends on its shop, so re-approving a shop must outrank the delete written while it was suspended. Deletes carry a version too.
- **D36 An Elasticsearch outage does not consume an entry's attempts.** A failed request pauses the whole job with growing back-off (2 s up to 60 s). Only per-document rejections increment `attempts` (back-off up to 5 min); at 10 attempts the entry is logged at `error`, kept, and no longer claimed. A successful reindex deletes flagged entries older than itself.
- **D37 Fixed name `products_v0` for the first index** so concurrent first boots cannot attach two indices to the alias.
- **D38 Cache circuit breaker:** after a Redis failure, cache reads/writes are skipped for 5 s; deletes are always attempted.
- Search is registered in `products.routes.js` (as HANDOVER Phase 2 required); the admin reindex route lives in `modules/search/search.routes.js`.

## Relevant files

New: `server/src/modules/search/` (`search.model` outbox, `.mapping`, `.query` pure ES-DSL builder, `.index` the only ES-touching file, `.docs` Mongo->documents, `.outbox`, `.fallback`, `.service`, `.reindex`, `.validator`, `.controller`, `.routes`), `server/src/jobs/` (`jobLock.js`, `searchSync.js`), `server/src/lib/cache.js`, `server/src/scripts/reindex.js`, `server/tests/` (`fakeSearch.js`, `phase3.unit.test.js`, `search.test.js`), `client/src/lib/search.js` (+ test), `client/src/pages/SearchPage.jsx`.
Changed: `app.js`, `server.js`, `config/constants.js`, `middleware/rateLimit.js`, `catalog/products.{routes,service}.js`, `catalog/categories.service.js`, `shops/shops.service.js`, `tests/{db,helpers,rbac.test}.js`, `client/src/{App.jsx,components/Layout.jsx,pages/HomePage.jsx,pages/catalog.css}`, both `package.json` (script `reindex`).

## API changes

| Method | Path                             | Auth   | Notes                                                                                                                                             |
| ------ | -------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/products/search`               | Public | contract shape; `X-Search-Fallback: mongo` when degraded; 422 on bad params; 429 over 60/min/IP                                                   |
| POST   | `/admin/search/reindex`          | Admin  | 200 `{ index, indexed, durationMs }`; 503 if search not configured or rebuild fails (old index kept); 409 if another sync/reindex holds the lease |
| GET    | `/categories`, `/products/:slug` | Public | unchanged shape, now cached                                                                                                                       |

CORS now also exposes `X-Search-Fallback`.

## Schema changes

New collections: `searchOutbox` (`productId, op, attempts, nextAttemptAt, lastError, createdAt`; indexes `{nextAttemptAt}`, `{productId}`) and `jobLocks` (`_id, lockedUntil, owner`), as in DATABASE_SCHEMA supporting collections (I added the `{productId}` index). New audit action `search.reindexed` (entityType `search`, entityId = acting admin id because the audit schema needs an ObjectId).

## Environment variables

None new. Uses `ELASTICSEARCH_URL`, `REDIS_URL`, `MONGODB_URI` (all existing).

## Verification

Run in a sandbox with real MongoDB 8.3.7 (replica set) and real Redis; **no real Elasticsearch**.

- Server: 308 tests pass (243 existing + 65 new). Client: 50 tests pass; `vite build` OK; ESLint clean; Prettier clean.
- Real Redis check: cache round-trip and TTL OK; with Redis killed, get/set/del degrade to misses without throwing; the rate limiter still enforces its limit via the in-memory fallback.
- Real `server.js` boot with Redis and ES both unreachable: starts, `/health/ready` = `degraded`, search = 200 + `X-Search-Fallback: mongo`, categories 200.
- Elasticsearch logic is tested against an in-memory fake (`tests/fakeSearch.js`) and a mock client (request bodies, versioning flags, alias swap actions).

**Not verified (needs your Docker stack):**

1. Real ES: mapping accepted, query DSL results/relevance, `external_gte` on delete, alias swap during a concurrent query loop.
2. "Visible in search within 10 s, p95 over 20 runs".
3. `npm run reindex` on 1,000 seeded products with zero failed concurrent searches.
4. "Cached product detail p95 < 50 ms vs uncached" (not measured).
5. A real browser pass of the search UI.

Commands: `docker compose up -d --wait`, `npm run dev:server`, create an approved vendor + product (see Phase 2 dev workflow), wait ~2 s, `curl 'localhost:4000/api/v1/products/search?q=...'`; `docker compose stop elasticsearch` and repeat to see `X-Search-Fallback`; `npm run reindex`.

## Known issues

- Category rename / re-parent / deactivation is not propagated to the index (`categoryIds`) or caches; run a reindex after such changes. Deactivating a category still does not hide its products (Phase 2 issue).
- A vendor with a very large catalog enqueues all its products inside one transaction on status change; fine for MVP volumes.
- Reindex runs inside the HTTP request; for catalogs much larger than a few thousand products move it to a background job.
- Search results may show `inStock` up to 60 s stale (cache) and index lag (~2 s sync + ES refresh).
- Mongo fallback first loads all approved shops (`$in`); fine for MVP.
- Dependencies in `shops`/`products` services (`searchOutbox`, `cache`) are required parameters; any new caller must pass them.
- Phase 1/2 known issues unchanged. Doc conflict: API_CONTRACTS says a `rejected` vendor is terminal, code/constants allow `rejected -> approved`.

## Next-phase prerequisites (Phase 4: Cart + coupons)

- Review and approve Phase 3, then create the branch.
- Cart pricing/stock preview must read Mongo, never the cache or the search index.
- Run the real-ES checks above before relying on search in a demo; decide ES/Redis hosting (V4) if deploying soon.
