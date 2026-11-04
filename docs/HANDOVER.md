# HANDOVER.md

## Current state (after Phase 8: Admin console and analytics)

Phase 8 code is implemented and **verified by automated tests in the assistant's sandbox only** (not yet run on the owner's machine; no browser check). Phase 6's accepted **D57 vendor-debit formula is now implemented and tested** (it was the open follow-up). The admin console covers analytics (cards, GMV chart, top vendors/products), orders (list, detail, refund form, early release), vendors, products (suspend/restore), reviews (hide/publish), platform coupons (create, enable/disable) and settlements (release, reconciliation). Phase 9 (hardening/deployment) is next and has not been started.

## Decisions

D57 implemented (see DECISIONS). **D64-D67 are Proposed and need the owner's review:** D64 what analytics count (paid orders by `placedAt`, UTC, inclusive days; gross GMV with refunds beside it; top products exclude cancelled sub-orders; reviews not counted); D65 product moderation (`suspended` / back to `draft` only); D66 admin reads added beyond the contract (`GET /admin/products`, `GET /admin/reviews`; no separate refunds list; `/admin/users` not built); D67 analytics queries, 5-minute TTL cache, speed, and the consequence that the time series has orders and GMV only.

## Relevant files

New (server): `src/modules/admin/` `admin.{validator,service,controller,routes}.js`, `analytics.service.js`. New tests: `analytics.test.js`, `admin.test.js`, `adminAudit.test.js`, `phase8.helpers.js`.
New (client): `src/lib/admin.js` (+ `admin.test.js`), `src/admin/` (`AdminLayout`, `AdminAnalyticsPage`, `AdminOrdersPage`, `AdminOrderPage`, `AdminVendorsPage`, `AdminProductsPage`, `AdminReviewsPage`, `AdminCouponsPage`, `AdminSettlementsPage`, `charts.jsx`, `Pager.jsx`, `hooks.js`, `admin.css`).
Changed: `src/lib/refunds.js` and `src/modules/refunds/refunds.service.js` (D57); `src/app.js` (wiring); `src/config/constants.js` (`ANALYTICS`, `ADMIN_PRODUCT_TRANSITIONS`, analytics cache key/TTL); `orders.model.js`, `reviews.model.js` (one index each); `tests/phase6.unit.test.js`, `tests/refunds.test.js`, `tests/rbac.test.js`; client `App.jsx` (admin routes), `components/Layout.jsx` (Admin link). Docs: DECISIONS, API_CONTRACTS, DATABASE_SCHEMA, IMPLEMENTATION_PLAN, TESTING, this file.

## API changes

New: `GET /admin/products`, `PATCH /admin/products/:productId/status`, `GET /admin/reviews`, `GET /admin/orders`, `GET /admin/orders/:orderId`, `GET /admin/analytics/{overview,sales-timeseries,top-vendors,top-products}` (shapes in API_CONTRACTS "Phase 8"). New audit action `product.status_changed`. Behaviour change (D57): `vendorDebitPaise` of a refund is now proportional to the actual vendor payout (differs from the old value only under platform-funded coupons).

## Schema changes

No new collection or field. Indexes added: `orders {paymentStatus:1, placedAt:-1}`, `reviews {status:1, createdAt:-1}`.

## Environment variables

None new.

## Commands

```
npm install
npm run lint && npx prettier --check .
npm test -w server           # needs a MongoDB replica-set binary (MONGOMS_SYSTEM_BINARY=/path/to/mongod)
npm test -w client && npm run build -w client
```

## Verification (what was actually run, in the assistant's sandbox, MongoDB 8.3.7)

Server: 956 passed, 1 failed (below, pre-existing). Client: 143 passed; production build OK. ESLint: 1 error, pre-existing. Analytics speed on 10,000 seeded orders (median of 5 runs): overview 136 ms, time series 117 ms, top vendors 302 ms, top products 154 ms; please re-measure on your machine.
**Not verified:** the admin console in a browser; real Razorpay behaviour (A6, A11-A13 unchanged); results on your machine.

## Known issues

- **Pre-existing, not caused by Phase 8:** `reviews.test.js` "works inside 30 days and is 409 edit_window_closed after" fails here: the test's helper tries to back-date `createdAt`, which Mongoose 9.11.4 treats as immutable. Adding `overwriteImmutable: true` to that `updateOne` makes all 38 review tests pass (verified, then reverted: not changed).
- **Pre-existing:** ESLint reports an unused `api` import in `tests/invoices.test.js`; `prettier --check` flags 13 files of the uploaded snapshot (Phase 7 files and some docs), although HANDOVER reported it passing.
- The time series has no commission/refund per day (D67). Analytics are up to 5 minutes old (TTL only).
- Admin `refundablePaise` mirrors the refund endpoint's rules for display only; users list/suspend (`/admin/users`) is not built.
- Product restore returns to `draft`, not to the previous status (D65).

## Next-phase prerequisites (Phase 9: Hardening and deployment)

- Owner review of D64-D67; run the checks above on your machine and click through the console.
- Phase 9 items from IMPLEMENTATION_PLAN (npm audit, rate limits, deploy, README). Consider Phase 9: a denormalized `paidAt` on sub-orders if per-day commission is wanted; the manual Razorpay test-mode script (TESTING section 4) is still outstanding.
