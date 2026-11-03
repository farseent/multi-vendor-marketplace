# TESTING.md

## 1. Strategy

| Level             | Tooling                                                                    | What it covers                                                                             | Target                                               |
| ----------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Unit              | Vitest/Jest                                                                | money/rounding, commission, discount allocation, coupon rules, state machines, token utils | ≥ 90% of `lib/money`, commission, coupon services    |
| Property-based    | fast-check                                                                 | allocation sums, commission+payout=base, refund reversal totals                            | 1,000 runs each                                      |
| Integration       | supertest + mongodb-memory-server (replica set) + Redis/ES containers      | every endpoint: authz matrix, validation, transactions, idempotency, jobs                  | all endpoints; ≥ 80% line coverage overall           |
| Provider contract | HTTP stub (nock/msw) based on provider docs; separate manual test-mode run | signature verification, webhook replay, failure paths                                      | all provider interactions stubbed; manual run logged |
| E2E               | Playwright                                                                 | 3 journeys below                                                                           | green in CI                                          |
| Security          | integration tests + `npm audit` + checklist                                | authz, injection, rate limits, headers                                                     | no high/critical                                     |
| Performance smoke | autocannon/k6                                                              | search, product detail, checkout concurrency                                               | thresholds in plan                                   |

Rules: no test hits real payment/AWS services; provider stubs reflect documented behaviour only (never invented). Test data via factories; each test isolates DB. Concurrency tests use real parallel requests (Promise.all) against the integration app.

## 2. Authorization test matrix

Generated from the registered route table: for each route × role (anonymous, customer, vendor-approved, vendor-pending, admin) assert expected status (200/201 vs 401/403). Add explicit cross-tenant tests: vendor A vs vendor B for products, sub-orders, settlements, coupons; customer A vs customer B for orders, invoices, addresses, reviews.

## 3. Acceptance checklist

### Auth & security

- [ ] Register/login/logout/refresh work; rotated refresh reuse revokes family
- [ ] 11th login in 15 min → 429; register rate limit enforced
- [ ] `passwordHash`, tokens, secrets never in any response or log (log-capture test)
- [ ] Unknown body fields rejected (422); `{ "email": { "$gt": "" } }` login attempt rejected
- [ ] CORS rejects non-allowlisted origin; helmet headers present
- [ ] Authz matrix passes for every route

### Vendors & catalog

- [ ] Unapproved vendor cannot publish; suspended vendor's products vanish from public + search
- [ ] Cross-vendor access returns 404 on all product/sub-order/coupon/settlement endpoints
- [ ] Presign constraints enforced (type, size, key prefix)

### Search & cache

- [ ] Product changes appear in search ≤ 10 s; ES outage → Mongo fallback header; outbox drains after recovery
- [ ] Reindex with zero failed concurrent searches
- [ ] Redis outage does not cause 5xx; cache invalidation on product update verified

### Cart & coupons

- [ ] 10 coupon rule cases pass; allocation sums exactly

### Checkout & payments

- [x] 50 concurrent buyers, stock 10 → 10 orders, stock 0
- [x] Idempotency-Key replay returns same order
- [x] Multi-vendor order produces correct sub-orders, totals, commission (property tests pass)
- [x] Bad signature / amount mismatch rejected; order unchanged
- [x] Webhook duplicate/concurrent/out-of-order (refund before captured) safe _(payment events: Phase 5, 20-way concurrent claims; refund and transfer events: Phase 6, duplicates, unknown ids and bodies that disagree with the provider are all harmless; "refund before captured" cannot happen because a refund is only ever created for a captured payment)_
- [x] Reservation expiry restores stock and coupon once
- [x] Late capture after expiry handled (re-reserve or auto-refund)

### Fulfillment, refunds, settlement

- [x] Transition table enforced _(all 25 from/to pairs through the API, plus every actor in the pure table)_
- [x] Partial/full refunds reconcile commission to the paisa; cannot exceed paid amount _(property test, 1,000 runs, and through the API; concurrent refunds cannot overshoot)_
- [x] Cancel-before-ship restores stock once _(double call and concurrent customer/vendor cancels)_
- [x] Settlement lifecycle correct; open refunds block release
- [x] Reconciliation detects seeded mismatch

### Reviews, invoices, admin

- [ ] Review eligibility and uniqueness enforced; aggregates correct _(written in `reviews.test.js`; **not run**, see HANDOVER)_
- [ ] Invoice access limited to owner and paid orders _(written in `invoices.test.js`; **not run**)_
- [ ] Analytics equals fixture-computed values; every admin mutation audited

### Non-functional

- [ ] Standard error envelope + requestId on all errors; no stack traces in production mode
- [ ] Health endpoints report degraded (not down) when ES/Redis are off
- [ ] Smoke load: 50 users / 2 min, error rate < 1%
- [ ] Fresh-clone setup ≤ 15 min

## 4. Manual test-mode payment script (run after V1-V3 are resolved)

Prerequisites (DECISIONS D44, D46, D48, D49): Route usable in the test-mode Dashboard with a linked account attached by `npm run link-account`; auto-capture enabled; a webhook with its own secret pointing at a URL Razorpay accepts (not localhost, and not a blocklisted tunnel such as ngrok: use a staging deployment or `zrok`); `PAYMENT_PROVIDER=razorpay` with the test keys. Also confirm DECISIONS assumptions A8-A10 while running it.

1. Create approved vendor + linked account in provider test mode. 2. Add products from 2 vendors, checkout with the provider's published test payment method. 3. Confirm order `placed`, transfers created on hold. 4. Mark delivered, advance time (or use admin release), confirm settlement transitions. 5. Issue partial refund, confirm commission reversal and transfer reversal. **Do this BOTH while the transfer is still on hold and after release** (DECISIONS A6 is only half closed: nothing I read says an on-hold transfer can be reversed). Also: cancel an unshipped sub-order, then check `refund.processed` and `transfer.processed` arrive and the payload path `payload.transfer.entity.id` (A11). Record results in `docs/PAYMENT_TEST_LOG.md`; do not claim results before running.

## 5. E2E journeys

(1) Customer: register → search → add multi-vendor cart → apply coupon → pay (test) → see order. (2) Vendor: register → create shop → admin approves → create product → fulfil sub-order to delivered. (3) Admin: approve vendor → refund sub-order → view analytics.
