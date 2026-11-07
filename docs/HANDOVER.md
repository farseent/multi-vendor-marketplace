# HANDOVER.md

## Current state (after Phase 9: Hardening and deployment, code and docs)

Phase 9 code, tests and docs are delivered; **deployment and the checks that need your hosts are not done**. Before Phase 9 you reported that all server and client tests pass and that `npm audit` shows 0 vulnerabilities at the root, in `client/` and in `server/`. The Phase 9 changes below were verified only partly in the assistant's sandbox (see Verification). Admin console browser check (Phase 8) is still outstanding.

What changed: Elasticsearch is optional (D70); the production config refuses the `.env.example` JWT placeholder; CI fails on high/critical `npm audit` findings; Vercel rewrite and Render Blueprint added (D68, D69); a load smoke script, a demo-data script (D72) and a rate-limit/proxy test (D71) added; `seed:admin` (missing from `server/package.json`) added; README rewritten; DEPLOYMENT and SECURITY_CHECKLIST written.

## Decisions

**D68-D72 are Proposed and need your review:** D68 hosts (Vercel, Render, Atlas M0, Upstash, S3, Razorpay test); D69 V5 resolved by a same-origin rewrite, `TRUST_PROXY=2`; D70 optional Elasticsearch with a no-op outbox when unset; D71 rate limits unchanged but pinned by tests; D72 demo data through the HTTP API. Earlier Proposed items D64-D67 (Phase 8) still await your review.

## Relevant files

New: `docs/DEPLOYMENT.md`, `docs/SECURITY_CHECKLIST.md`, `render.yaml`, `client/vercel.json`, `server/src/scripts/{demoData,seedDemo,smoke}.js`, tests `server/tests/{optionalSearch,proxyRateLimit,demoData,seedDemo,smoke}.test.js`.
Changed (server): `src/config/env.js`, `src/server.js`, `src/app.js` (`searchOutboxEnabled`), `src/modules/search/search.outbox.js`, `src/scripts/reindex.js`, `package.json` (scripts `seed:admin`, `seed:demo`, `smoke`; devDependency `autocannon`), `tests/env.test.js`, `.env.example`.
Changed (root/client): `package.json` (scripts `audit`, `seed:admin`, `seed:demo`, `smoke`), `.github/workflows/ci.yml` (audit step), `client/.env.example`, `README.md`. Docs: DECISIONS, IMPLEMENTATION_PLAN, TESTING, this file.

## API changes

None. Behaviour change: with `ELASTICSEARCH_URL` unset, `POST /admin/search/reindex` answers 503 and `/health/ready` has no `elasticsearch` component.

## Schema changes

None.

## Environment variables

`ELASTICSEARCH_URL` is now **optional** (unset or empty = Mongo fallback, D70). In production `JWT_ACCESS_SECRET` may not start with `change-me`. Script-only variables: `SEED_API_URL` (seed:demo, default `http://localhost:4000/api/v1`), `ADMIN_SEED_*` (also read by seed:demo), `SMOKE_URL`, `SMOKE_CONNECTIONS`, `SMOKE_DURATION` (smoke). Production requires `PAYMENT_PROVIDER=razorpay` with the three Razorpay variables (unchanged rule).

## Commands

```
npm install                  # installs the new devDependency (autocannon); commit the updated package-lock.json files
npm run lint && npm run format:check
npm test
npm run build
npm run audit
npm run seed:admin && npm run seed:demo     # API running
TRUST_PROXY=1 npm run dev:server            # then, in another terminal: npm run smoke
```

## Verification (what was actually run)

Sandbox (Node 22.23, packages installed fresh from the uploaded package.json files, **no MongoDB, and the uploaded zip lacked many source files** such as `jobs/` and the catalog models, so the full server suite could not be run):

- ESLint and Prettier (`--check`) on the uploaded files and every file changed here: clean.
- Passed: `env.test.js` `parseEnv` group (17 tests, including the two new ones), `proxyRateLimit.test.js` (5), `demoData.test.js` (5), `seedDemo.test.js` (2, against an in-memory fake API), `smoke.test.js` (4), `logger.test.js`.
- The smoke script ran for 4 s against a throwaway local HTTP server: 72,866 requests, 0 errors, exit 0. This checks the script, not your API.
- **Not run:** `env.test.js` "server boot" group and `optionalSearch.test.js` (they import files missing from the zip), the rest of the server suite, the client suite and build, anything against Mongo/Redis/Elasticsearch/S3/Razorpay, any deployment, the real smoke test, the timed fresh-clone check, README screenshots.
- Please run `npm install && npm run lint && npm run format:check && npm test && npm run build` on your machine and tell me the result before trusting the new code.

## Known issues and security notes

- `seed:demo` request bodies follow API_CONTRACTS, but the category body (`{ name, parentId? }`) and the field names it reads from responses (`id`, `status` on the shop profile) are assumptions: if a call is rejected the script prints the API's validation details and only that request needs changing.
- Demo accounts share one public password (`demoData.js`): demo databases only. Use your own `ADMIN_SEED_PASSWORD`.
- Free Render sleeps, so the in-process jobs (D17) pause; checkout on the deployed site needs a working Razorpay test setup (the deferred manual runs, TESTING section 4).
- `TRUST_PROXY=2` and the Vercel rewrite are unverified on the real hosts (DEPLOYMENT step 7). The global limit of 300 per 15 minutes per IP is tight for people sharing one address (D71).
- Items marked Open in `docs/SECURITY_CHECKLIST.md` (validators' `.strict()`, S3 presign constraints, webhook signature code) were not re-reviewed.
- Carried over: Phase 8 console not checked in a browser; D67 per-day commission (`paidAt` on sub-orders) not built; `/admin/users` not built.

## Next steps (owner-run, then review)

1. Run the commands above; review D68-D72 and D64-D67.
2. Deploy following `docs/DEPLOYMENT.md`; record each result in `TESTING.md` and here.
3. Run `npm run smoke` (local API, `TRUST_PROXY=1`), time a fresh clone, add README screenshots.
4. Complete the Razorpay test-mode runs (Phases 5 and 6) so checkout can be demonstrated.
