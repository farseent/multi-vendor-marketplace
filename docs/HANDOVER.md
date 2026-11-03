# HANDOVER.md

## Current state (after Phase 7: Reviews and invoices)

Phase 7 code is implemented. **Owner reports the automated local checks completed successfully:** dependency installation, lint, Prettier formatting/check, server tests, client tests and client production build. Test counts were not supplied. Manual browser checks for reviews/invoices and manual Razorpay test-mode payment/refund checks for Phases 5-6 are intentionally deferred to the relevant end-of-phase manual verification passes. No Phase 8 code exists (no admin UI, analytics, or admin review listing). The shared upload did not include `.git`, so commit status is not verified here. **One accepted Phase 6 decision still requires a code/test change:** D57 now requires platform-funded coupon refunds to debit the vendor's proportional actual payout; the current implementation described in the previous handover used the D9-only formula and must be aligned before Phase 6 is considered complete.

- **Reviews:** `GET /products/:productId/reviews` (public), `GET .../reviews/mine`, `POST .../reviews`, `PATCH|DELETE /reviews/:reviewId` (owner, 30 days), `PATCH /admin/reviews/:reviewId/status`. Eligibility = a `delivered` sub-order of the customer containing the product (403 otherwise); one review per customer and product (409 `REVIEW_EXISTS`). Every rating-changing action recomputes `ratingAvg` (2 decimals) and `ratingCount` from published reviews inside the same transaction, then deletes `cache:product:{slug}` and enqueues a search re-index (D61, D62).
- **Invoices:** `GET /orders/:orderId/invoice` (owner customer, paid only). Number `INV-YYYY-NNNNNN` stored once per order (unique `orderId`, counter `invoice:YYYY`); PDF rebuilt on every download with pdfkit, shows every seller's items, coupon/discount, total and any refunds (D63).
- **Client:** reviews section on `/products/:slug` (list, pagination, write/edit/delete form), "Download invoice (PDF)" on `/orders/:orderId` for paid orders (fetched with the bearer token and saved as a blob).

## Accepted decisions (2026-11-03)

D57-D63 have been reviewed and accepted by the owner. Key outcomes:

- **D57 refunds:** keep D9 commission reversal, but calculate vendor debit proportionally from actual `vendorPayoutPaise` for all refunds; a full refund under a platform-funded coupon leaves vendor payout at zero and the platform bears the coupon subsidy. Reject a calculated vendor transfer reversal of 1-99 paise with 422 `refund_below_minimum`; zero is allowed. Paid coupon redemptions remain consumed after cancellation/refund.
- **D58 fulfillment:** suspended vendors cannot ship/deliver even previously paid orders. All-cancelled sub-orders make the parent order `cancelled`; a mixed delivered/cancelled order is `completed`.
- **D59-D60:** admin manual settlement release may bypass only the 7-day window; all other guards remain. Reconciliation is read-only and never corrects financial records.
- **D61 reviews:** full refund does not remove review eligibility; hard deletion permits a new review and fresh 30-day edit window; editing a hidden review does not republish it.
- **D62:** recompute rating aggregates from published reviews; store `ratingAvg` to 2 decimals.
- **D63:** keep generic invoice platform name `Marketplace` for now.

D57's revised `vendorDebitPaise` formula is an implementation/test follow-up, not merely a documentation change.

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

**Owner-reported passing commands:** `npm install`; `npm run lint`; `npx prettier --write .`; `npx prettier --check .`; `npm test -w server`; `npm test -w client`; `npm run build -w client`. The owner reports these completed successfully; exact test counts/output were not included in the handover. This confirms the automated test and client-build checks only; manual browser and Razorpay provider checks remain deferred.

**Still not manually verified:** review and invoice behavior in the browser; visual PDF layout after downloading; real Razorpay checkout, refund-before-release and refund-after-release behavior (including whether an on-hold transfer can be reversed, A6); and the provider payload assumptions A11-A13. Automated test/build commands are owner-reported passing. The accepted D57 platform-funded coupon vendor-debit change has not yet been implemented or tested.

## Known issues

- No admin list of reviews (Phase 8): an admin needs a review id to un-hide one.
- Invoice is not a tax invoice; text outside Latin-1 prints as `?`; amounts print as `INR` (no rupee glyph).
- Invoice year follows generation date, not order date.
- `soldCount` still not maintained. Phase 6 provider limitations remain: reversal and refund are separate provider calls; a provider refund failure after a successful reversal requires manual action; reconciliation checks one-by-one and is read-only; order page lists first 50; A1-A13 checks remain as recorded. D57's accepted platform-funded coupon vendor-debit calculation still needs implementation and tests.

## Next-phase prerequisites (Phase 8: Admin console and analytics)

- Implement and test the accepted D57 platform-funded coupon vendor-debit formula before treating Phase 6 as fully aligned. D57-D63 owner review is complete; manual Razorpay and browser checks are intentionally deferred to the phase-end manual verification passes.
- Phase 8's "every admin mutation is audited" route-table test: `PATCH /admin/reviews/:id/status` audits only real changes.
- Admin UI needs review listing (`GET /admin/reviews`, not built) and may reuse `reviews` indexes.
- Decide whether analytics should count refunded orders and hidden reviews; this remains a Phase 8 product/reporting definition, not a D57-D63 open decision.
