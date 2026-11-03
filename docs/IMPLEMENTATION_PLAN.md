# IMPLEMENTATION_PLAN.md

Approach: vertical slices (backend + minimal frontend per phase). Each phase ends with passing tests and a demoable result. Do not start a phase until the previous phase's criteria pass. Local infra via Docker Compose (Mongo replica set, Elasticsearch, Redis).

| Phase | Name                                              | Depends on                 |
| ----- | ------------------------------------------------- | -------------------------- |
| 0     | Foundations                                       | none                       |
| 1     | Auth, users, RBAC                                 | 0                          |
| 2     | Vendors, categories, products, uploads            | 1                          |
| 3     | Search + caching                                  | 2                          |
| 4     | Cart + coupons                                    | 2                          |
| 5     | Checkout, inventory, payments, webhooks           | 3 (search not required), 4 |
| 6     | Fulfillment, refunds, settlements, reconciliation | 5                          |
| 7     | Reviews + invoices                                | 6                          |
| 8     | Admin console + analytics                         | 6, 7                       |
| 9     | Hardening, deployment, demo polish                | all                        |

## Phase 0: Foundations

Scope: monorepo, ESLint/Prettier, env validation, Express app skeleton, error/request-ID/logging middleware, Mongo/Redis/ES clients with health checks, Docker Compose, CI (lint+test), React shell with router and API client.
Acceptance:

- `docker compose up` brings all services healthy; `GET /health/ready` returns 200 with component statuses.
- App refuses to boot (exit ≠ 0) if any required env var is missing/invalid (test proves it).
- An unhandled thrown error returns the standard error envelope with a `requestId` and no stack trace when `NODE_ENV=production`.
- CI runs lint + tests on every PR and fails on a lint error.

## Phase 1: Auth, users, RBAC

Scope: register/login/refresh/logout/me/change-password, refresh rotation with reuse detection, rate limits on auth, address CRUD, admin seed script, authorize middleware, frontend auth pages and protected routes.
Acceptance:

- [x] Passwords stored as bcrypt hashes (cost ≥ 12); no endpoint ever returns `passwordHash` (test).
- [x] Access token expires at 15 min; refresh rotates; replaying an old refresh token revokes the family and returns 401 (test).
- [x] 11th login attempt in 15 min from the same IP+email returns 429.
- [x] A customer token calling any `/vendor/*` or `/admin/*` route returns 403 (route-table test over every registered route). **Note:** Now covers real `/vendor/*` and `/admin/*` routes (`rbac.test.js` asserts the table is non-empty).
- [x] Duplicate email returns 409; weak password returns 422 with field details.

## Phase 2: Vendors, catalog, uploads

Scope: shop profile, admin vendor approval/commission, category CRUD, product CRUD with ownership checks, S3 presign, stock updates, vendor product UI, public product page.
Acceptance:

- [x] Vendor A requesting/editing Vendor B's product by ID gets 404 for GET, PATCH, DELETE and stock (4 tests).
- [x] Unapproved vendor cannot set a product `active` (403 `VENDOR_NOT_APPROVED`).
- [ ] Presign rejects content-type outside jpeg/png/webp and sizes > 5 MB; a product with an image key outside the vendor's prefix returns 422.
- [ ] Negative stock or non-integer price returns 422.
- [x] Public product endpoint never returns `draft/archived/suspended` products or products from non-approved vendors.

## Phase 3: Search and caching

Scope: ES index mapping, outbox + sync job, search endpoint with filters/sort/pagination, reindex command/endpoint, Mongo fallback, Redis cache for product/category/search, cache invalidation, search UI.

**Route registration requirement:** Register `/products/search` before `/products/:slug` in `products.routes.js` to prevent the dynamic slug route from matching the `search` path.

Acceptance:

- [ ] After a product create/update/archive, the change is visible in search within 10 s (measured in integration test, p95 over 20 runs).
- [ ] Killing ES: `/products/search` still returns 200 with `X-Search-Fallback: mongo`; restoring ES and running the sync drains the outbox to 0.
- [ ] `npm run reindex` on 1,000 seeded products completes and alias swap causes zero failed search requests during a concurrent query loop.
- [ ] Stopping Redis: product detail and search still return 200; error logged at `warn`; auth limiter still enforces limits.
- [ ] Product update invalidates `cache:product:{slug}`: the next GET returns the new price (test).
- [ ] Cached product detail p95 < 50 ms vs uncached measured locally and recorded in docs.

## Phase 4: Cart and coupons

Scope: cart endpoints, price/stock preview, coupon CRUD (vendor, admin), coupon validation service, cart UI.
Acceptance:

- [x] Cart quantity > 10 or product not purchasable returns 422/409 respectively; inactive products show as unavailable in preview.
- [x] Coupon validation covers 10 table-driven cases: expired, not started, disabled, below min order, over total limit, over per-user limit, wrong vendor scope, percent with cap, fixed larger than subtotal (clamped to subtotal), valid.
- [x] Vendor coupon applies only to that vendor's items; discount allocation sums exactly to total discount (property test over 1,000 random carts).

## Phase 5: Checkout, inventory, payments

Scope: `PaymentProvider` interface + Razorpay and MockLedger implementations, checkout transaction, commission calculation, provider order with transfers, verify endpoint, webhook handler with idempotency, reservation-release job, reconcile-pending job, order UI + provider widget.

**Gate (resolved 2026-11-01):** V1-V3 were researched (DECISIONS D44-D48 and its source register) and the owner's choices are Accepted as D47-D51. V1's original definition is unknown; D44 gives it a new, inferred one. D52-D56 record decisions made during implementation and await the owner's review.

**Delivered in five slices:** 5a `PaymentProvider` contract, MockLedger, commission maths with property tests, the new models; 5b `link-account` admin script and the checkout transaction; 5c `markOrderPaid`, `/payments/verify`, the webhook with atomic claiming; 5d reservation-release and reconcile jobs, late capture; 5e Razorpay adapter, order endpoints, checkout/orders UI. Slices 5a-5d run on MockLedger and HTTP stubs and never need Razorpay access; only the manual run below does.

Environment variables: `PAYMENT_PROVIDER` (`mock` default, refused in production, or `razorpay`), `PLATFORM_COMMISSION_BPS` (0-5000, default 1000), and `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (required only for `razorpay`).

Acceptance (automated checks are named; "not run" means it needs the owner's Razorpay test account):

- [x] 50 concurrent checkouts for a product with stock 10 yield exactly 10 successes and 40 `OUT_OF_STOCK`; final `stockQty = 0` (never negative). (`checkout.test.js`)
- [x] Same `Idempotency-Key` sent 5 times concurrently creates exactly 1 order (and one provider order). (`checkout.test.js`)
- [x] A multi-vendor cart (3 vendors) creates 1 order + 3 sub-orders; `sum(subOrders.customerTotalPaise) == order.totalPaise` and `commission + vendorPayout == base` hold for each (property test, 1,000 random carts, incl. odd-paise rounding). (`phase5a.unit.test.js`, `checkout.test.js`)
- [x] Tampered client amount/signature in `/payments/verify` returns 400 and the order stays `pending_payment`. (`payments.test.js`)
- [x] Same webhook delivered 3× (and concurrently with `/payments/verify`) transitions the order once; `webhookEvents` has 1 row; stock/coupon counters unchanged afterwards. (`payments.test.js`)
- [x] Unpaid order is expired within 16 min; stock and coupon restored exactly once. (`jobs.test.js` with an injected clock; also observed once with the real job on a running server)
- [x] Late-capture on expired order with no stock results in an automatic full refund record. (`payments.test.js`, `jobs.test.js`)
- [x] (D47/D49/D50) Checkout writes nothing and answers 422 `zero_total` / `below_minimum_total`, 409 `vendor_payout_unavailable`, 422 `payout_below_minimum`, 422 `COUPON_INVALID` `exceeds_platform_margin`. (`checkout.test.js`)
- [x] (D49) The `link-account` script changes nothing and exits non-zero for a non-admin actor, an unknown or unapproved vendor, a malformed or provider-unknown account id, an account already attached to another vendor, or a replacement without `--replace`; on success it writes exactly one `vendor.payout_account_attached` audit entry. (`linkAccount.test.js`; CLI also run once)
- [x] (D46) 20 concurrent deliveries of one event id whose row is `failed` (and, separately, `received` and older than 60 s) run the handler exactly once. (`payments.test.js`)
- [x] (D51) The app refuses to boot when `PLATFORM_COMMISSION_BPS` is not an integer from 0 to 5000, and uses 1000 when it is unset. (`phase5a.unit.test.js`; production refusal of the mock also run once)
- [ ] Manual test-mode payment completes end to end with provider test credentials (recorded in a short demo video/log; **not run**: it needs Route enabled on your test account, a linked account, auto-capture, a webhook URL Razorpay accepts, and the checks in DECISIONS A4, A8, A9, A10).

## Phase 6: Fulfillment, refunds, settlements

Scope: vendor sub-order status flow, customer cancel, admin refund, commission reversal, settlement state machine and release job, reconciliation job and admin report, vendor settlement view.
Acceptance:

- [x] Every disallowed transition in the table returns 409 (table-driven test). (`fulfillment.test.js`: 25 pairs through the API; `phase6.unit.test.js`: every actor)
- [x] Partial refunds sum correctly: refunding 3 × arbitrary partial amounts with a final remainder refund leaves `commissionReversed` total == commission and `netPayout` ≥ 0 (property test). (`phase6.unit.test.js`, 1,000 runs each for vendor-funded and platform-funded; `refunds.test.js` through the API)
- [x] Refund total can never exceed `customerTotalPaise` (409). (`refunds.test.js`, including 5 concurrent refunds)
- [x] Cancel before shipping restores stock exactly once (double-call test). (`fulfillment.test.js`, also 3 concurrent cancels)
- [x] Settlement moves to `pending_release` only on `delivered`; release job ignores settlements with an open refund or return window not elapsed. (`settlements.test.js`)
- [x] Reconciliation run on seeded data with one deliberately mismatched transfer reports exactly that mismatch. (`reconciliation.test.js`)
- [ ] Manual test-mode run of a refund before and after release (**not run**: needs your Razorpay account; DECISIONS A6, A11).

## Phase 7: Reviews and invoices

Scope: review CRUD with eligibility, rating aggregates, moderation, PDF invoice, UI.
Acceptance:

- [ ] Review without a `delivered` sub-order containing that product returns 403; second review for the same product returns 409. (`reviews.test.js`; **tests written, not run**)
- [ ] `ratingAvg/ratingCount` correct after create/edit/delete/hide (test with 5 operations) and cache invalidated. (`reviews.test.js`, 7 operations, plus 8 concurrent creates; `phase7.unit.test.js`; **not run**)
- [ ] Invoice PDF downloads only for the order's owner, only when paid; lists every vendor's items, discount, total; numbering is gap-tolerant but unique under 20 concurrent generations. (`invoices.test.js`; **not run**)

## Phase 8: Admin console and analytics

Scope: admin UI for vendors/products/reviews/coupons/orders/refunds/settlements, analytics endpoints with aggregation pipelines and caching, charts.
Acceptance:

- Analytics totals equal values recomputed directly from seeded fixtures (GMV, commission, order count) exactly.
- Analytics endpoints respond < 500 ms on 10,000 seeded orders locally (measured; recorded).
- Every admin mutation creates an `auditLogs` entry (route-table test).

## Phase 9: Hardening and deployment

Scope: security review checklist, dependency audit, rate-limit tuning, load smoke test, deploy frontend and backend separately, environment docs, seed/demo data, README with architecture and screenshots.
Acceptance:

- No high/critical `npm audit` findings (or documented exceptions).
- Deployed frontend talks to deployed backend with working login/refresh (V5 resolved), CORS allows only the frontend origin.
- Full acceptance checklist in TESTING.md passes; k6/autocannon smoke (50 concurrent users, 2 min) shows error rate < 1%.
- README lets a new developer run the project locally in under 15 minutes (timed).
