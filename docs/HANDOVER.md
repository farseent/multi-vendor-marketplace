# HANDOVER.md

## Current state (after Phase 7: Reviews and invoices)

Phase 7 code and tests are WRITTEN but NOT RUN: the environment had no network, so `npm install`, vitest, ESLint, Prettier and the Vite build could not run, and there is no MongoDB. Only `node --check` on every file and plain-node checks of the pure helpers were run (see Verification). Treat Phase 7 as unverified until the commands below pass on your machine. No `.git` folder was uploaded; nothing is committed. Phases 1-6 are unchanged except for the items under "Behaviour changes". No Phase 8 code exists (no admin UI, analytics, review listing for admins).

- **Reviews:** `GET /products/:productId/reviews` (public), `GET .../reviews/mine`, `POST .../reviews`, `PATCH|DELETE /reviews/:reviewId` (owner, 30 days), `PATCH /admin/reviews/:reviewId/status`. Eligibility = a `delivered` sub-order of the customer containing the product (403 otherwise); one review per customer and product (409 `REVIEW_EXISTS`). Every rating-changing action recomputes `ratingAvg` (2 decimals) and `ratingCount` from published reviews inside the same transaction, then deletes `cache:product:{slug}` and enqueues a search re-index (D61, D62).
- **Invoices:** `GET /orders/:orderId/invoice` (owner customer, paid only). Number `INV-YYYY-NNNNNN` stored once per order (unique `orderId`, counter `invoice:YYYY`); PDF rebuilt on every download with pdfkit, shows every seller's items, coupon/discount, total and any refunds (D63).
- **Client:** reviews section on `/products/:slug` (list, pagination, write/edit/delete form), "Download invoice (PDF)" on `/orders/:orderId` for paid orders (fetched with the bearer token and saved as a blob).

## Key decisions

D61-D63 in DECISIONS.md are **Proposed, need your review**. Open questions: (1) a fully refunded delivered sub-order still lets the customer review; (2) delete is a hard delete, so a customer can delete and re-review (restarts the 30 days); (3) platform name on invoices is the constant `INVOICE.platformName = "Marketplace"`; (4) rating average stored with 2 decimals. The five Phase 6 open questions (D57-D60) are still unanswered.

## Relevant files

New (server): `src/lib/ratings.js`; `src/modules/reviews/` `reviews.{model,validator,service,controller,routes}.js`; `src/modules/invoices/` `invoices.{model,view,render,service,controller,routes}.js`. New tests: `reviews.test.js`, `invoices.test.js`, `phase7.unit.test.js`, `phase7.helpers.js`.
New (client): `src/lib/reviews.js`, `src/lib/invoices.js` (+ tests), `src/components/ReviewsSection.jsx`, `src/components/reviews.css`.
Changed: `server/package.json` (+`pdfkit ^0.17.1`), `src/app.js` (wiring, `phase7Services`, CORS exposes `Content-Disposition`), `src/server.js` (index init), `src/config/constants.js`, `tests/db.js`, `tests/rbac.test.js`; client `lib/api.js` (+`apiDownload`), `pages/ProductPage.jsx`, `pages/OrderPage.jsx`. Docs: DECISIONS, API_CONTRACTS, DATABASE_SCHEMA, TESTING, IMPLEMENTATION_PLAN, this file.

## API changes

New endpoints listed above (shapes in API_CONTRACTS "implemented, Phase 7"). Addition beyond the contract: `GET /products/:productId/reviews/mine`. New 409 reasons `edit_window_closed`, `order_not_paid`; new 403 reason `no_delivered_purchase`. Audit action `review.status_changed`.

## Schema changes

New collections `reviews` and `invoices` exactly as DATABASE_SCHEMA already described (indexes added). `counters` gets `invoice:YYYY` ids. `products.ratingAvg/ratingCount` now maintained (they were always 0 before). No existing field changed.

## Environment variables

None new.

## Commands

```
npm install                  # installs pdfkit
npm run lint && npx prettier --write . && npx prettier --check .
npm test -w server           # needs a MongoDB replica-set binary (MONGOMS_SYSTEM_BINARY=/path/to/mongod)
npm test -w client && npm run build -w client
```

## Verification (what was actually run)

NOT RUN: server tests, client tests, ESLint, Prettier, Vite build, any PDF generation, any real database. Run: `node --check` on all new and changed server and client `.js` files (pass); plain-node assertions copying the unit tests for `ratingSummary`, `publicName`, `formatPaise`, `buildInvoiceView`, the client review validation and invoice helpers, and `apiDownload` with a mocked `fetch` (all pass). Expect first-run fixes in the integration tests and Prettier reformatting (long lines were written by hand).

**Not verified:** transaction retry behaviour under the 8-concurrent-review test; that pdfkit 0.17.1 exists and renders as written (layout never seen; open a downloaded PDF); `JSX` of the two edited pages and the new component (never compiled); the new `reviews/mine` route against the route-table tests; real Redis/Elasticsearch after a rating change; Phase 6 items still unverified (real Razorpay, A6, A11).

## Known issues

- No admin list of reviews (Phase 8): an admin needs a review id to un-hide one.
- Invoice is not a tax invoice; text outside Latin-1 prints as `?`; amounts print as `INR` (no rupee glyph).
- Invoice year follows generation date, not order date.
- `soldCount` still not maintained. All Phase 6 known issues carry over (refund steps not atomic at the provider, failed refunds/settlements have no retry, reconciliation is one-by-one, order page lists first 50, A1-A13 checks).

## Next-phase prerequisites (Phase 8: Admin console and analytics)

- Run the Phase 7 commands and fix what fails; review D61-D63 and D57-D60.
- Phase 8's "every admin mutation is audited" route-table test: `PATCH /admin/reviews/:id/status` audits only real changes.
- Admin UI needs review listing (`GET /admin/reviews`, not built) and may reuse `reviews` indexes.
- Decide whether analytics should count refunded or hidden-review data.
