# HANDOVER.md

## Current state (after Phase 6: Fulfilment, refunds, settlements)

Phase 6 is implemented and verified with the mock provider. Branch suggestion: `phase-6-fulfilment-refunds-settlements`. Phases 1-5 behave as before except where listed under "Behaviour changes to earlier phases". No Phase 7+ code exists (no reviews, invoices, admin UI, analytics). The upload had no `.git` folder, so nothing was committed.

- **Fulfilment:** the vendor moves a paid sub-order `processing → shipped → delivered` (`PATCH /vendor/sub-orders/:id/status`; `shipped` needs `tracking`). One transition table (`SUB_ORDER_TRANSITIONS`) serves every route; anything else is 409 `INVALID_STATE_TRANSITION`. Every move is a single conditional update, so double clicks and racing actors change the sub-order once. A vendor must be `approved` to change a status. Vendors see only paid sub-orders, with the shipping address and no other customer data.
- **Cancel:** the customer (`POST /orders/:orderId/sub-orders/:subOrderId/cancel`) or the vendor (`status: cancelled`) cancels a `processing` sub-order: stock returns once (`stockRestored`), everything not yet refunded is refunded, the settlement becomes `reversed`, all in one transaction. If the provider is down the cancel stands and the refund finishes later.
- **Refunds:** `POST /admin/sub-orders/:id/refund` (full or partial, delivered ones only inside the 7-day window). `subOrders.refundedPaise` is reserved atomically (the cap can never be exceeded, even concurrently), the refund is split per D9 (commission reversed proportionally, remainder on the final refund), then the provider is called: **vendor transfer reversal first, customer refund second**, each step stored on the row so a retry never repeats a finished step. A refund the provider has not accepted stays `initiated` and the reconcile job retries it after 5 minutes. A full refund of an unshipped sub-order also cancels it.
- **Settlements:** `not_eligible → pending_release` only on `delivered` (`eligibleAt = returnWindowEndsAt`); `→ reversed` when fully refunded before payout; hourly release job (`settlementRelease`): window elapsed, no open refund, net > 0, active payout account → `released` and `PATCH /v1/transfers/:id {on_hold:false}`; `released → settled | failed` by asking the provider (sweep + `transfer.processed` / `transfer.failed` webhooks; bodies are never trusted). Manual `POST /admin/settlements/:id/release` skips only the window.
- **Webhooks added:** `refund.processed`, `refund.failed`, `transfer.processed`, `transfer.failed` (each confirmed by a provider fetch). `refund.created`, `refund.speed_changed`, `settlement.processed` are stored `ignored`.
- **Reconciliation:** `reconciliationReports`; `POST /admin/reconciliation/run` (409 while another run holds the lease) and a daily job (hourly wake, runs when the newest report is over 23 h old). Compares each paid settlement with its provider transfer (amount, remaining after reversals, hold, settled, failed) and lists stuck or failed refunds. Report only; it never changes data.
- **Client:** `/vendor/orders` (filter, ship with tracking, deliver, cancel), `/vendor/settlements` (payout table), and on `/orders/:orderId` tracking, refund line and "Cancel this part of the order". No admin UI (Phase 8).

## Key decisions (DECISIONS.md)

**D57-D60 are Proposed and need your review:** D57 refund engine, D58 fulfilment rules, D59 settlements, D60 reconciliation. **Five open questions need your answer before merge** (listed at the end of D60): (1) a platform-funded coupon lets the vendor keep the platform's discount after a full refund (D9 applied literally; a one-line fix is described); (2) a paid order's coupon is not given back on cancel; (3) suspended vendors cannot fulfil existing orders; (4) the last 1-99 paise of a sub-order cannot be refunded (Razorpay reverses at least INR 1.00); (5) an order whose sub-orders are all cancelled becomes `cancelled`, not `completed`.
Research closed this phase: **A7** (refund event names are official) and half of **A6** (the transfer reversal API). **Still open: whether a transfer that is still ON HOLD can be reversed**; no page I read says so. See "Not verified".

## Relevant files

New (server): `src/lib/refunds.js` (pure refund maths); `src/modules/orders/` `orders.transitions.js`, `fulfillment.{service,controller,routes,validator}.js`; `src/modules/refunds/` `refunds.service.js`, `refunds.{controller,routes,validator}.js`; `src/modules/settlements/` `settlements.{service,controller,routes,validator,states,ledger}.js`, `reconciliation.{model,service}.js`; `src/jobs/settlementRelease.js`, `src/jobs/reconciliation.js`.
New tests: `fulfillment`, `refunds`, `settlements`, `reconciliation`, `phase6.unit` (property tests), `phase6.helpers.js`.
New (client): `src/lib/fulfillment.js` (+ test), `src/pages/VendorOrdersPage.jsx`, `VendorSettlementsPage.jsx`.
Changed: `src/app.js` (wiring; `app.get('phase6Services')` exposes the services to tests), `src/server.js` (index for the new model, two jobs), `src/config/constants.js`, `src/jobs/reconcilePending.js` (also retries and follows sub-order refunds), `src/modules/payments/{webhooks,payments}.service.js`, `src/modules/refunds/refunds.model.js`, `src/providers/payment/{PaymentProvider,mockLedger,razorpay}.js`, `tests/db.js`, `tests/razorpay.provider.test.js`; client `App.jsx`, `Layout.jsx`, `OrderPage.jsx`, `orders.css`. Docs: DECISIONS, API_CONTRACTS, DATABASE_SCHEMA, ARCHITECTURE (one sentence), TESTING, IMPLEMENTATION_PLAN, this file.

## Behaviour changes to earlier phases

- `subOrders.refundedPaise` now means refunds in `initiated` or `processed` (reserved at creation), not only processed ones.
- The Phase 5 late-capture refund now also marks the order's settlements `reversed` (net 0), because `reverse_all` takes every transfer back.
- `PaymentProvider` has four new methods (`releaseTransfer`, `reverseTransfer`, `fetchTransfer`, `fetchRefund`); the reconcile job takes an optional `refundsService`.
- The mock's `refundPayment` with `reverseAll` now reverses the order's transfers, and refunds can be made to start `pending` (`setNextRefundStatus`).

## API changes

New: `GET /vendor/sub-orders`, `GET /vendor/sub-orders/:id`, `PATCH /vendor/sub-orders/:id/status`, `POST /orders/:orderId/sub-orders/:subOrderId/cancel`, `POST /admin/sub-orders/:id/refund`, `GET /vendor/settlements`, `GET /admin/settlements`, `POST /admin/settlements/:id/release`, `GET /admin/reconciliation`, `POST /admin/reconciliation/run`. Shapes and error reasons: API_CONTRACTS ("implemented, Phase 6"). New 409 `details.reason` values: `exceeds_refundable`, `not_refundable`, `return_window_closed`, `idempotency_key_reused`, `run_in_progress`, `open_refund`, `nothing_to_release`, `payout_account_inactive`, `no_provider_transfer`, `changed_meanwhile`; new 422 reason `refund_below_minimum`. Audit actions: `refund.created`, `settlement.released`, `reconciliation.run`.

## Schema changes

`refunds.reason` adds `vendor_cancel`; `refunds.providerReversalId` (new, optional); new collection `reconciliationReports` (index `{runAt:-1}`); meaning of `subOrders.refundedPaise` (above). No other collection changed. DATABASE_SCHEMA.md is updated.

## Environment variables

None new. Two job intervals are constants in `config/constants.js` (`SETTLEMENT_JOB`, `RECONCILIATION_JOB`).

## Commands

```
npm install
npm run lint && npx prettier --check .
npm test -w server          # needs a MongoDB replica-set binary (MONGOMS_SYSTEM_BINARY=/path/to/mongod)
npm test -w client && npm run build -w client
```

## Verification (what was actually run, 2026-11-03)

Environment: Node 22, **real MongoDB 8.3.7** (single-node replica set from a conda-forge `mongod` via `MONGOMS_SYSTEM_BINARY`). No Razorpay, Redis or Elasticsearch.

- Server: **813 tests pass** (563 existing + 250 new, 30 files). Client: **86 pass** (71 + 15); `vite build` OK. ESLint clean; Prettier clean on the whole repo.
- All six Phase 6 acceptance checks are automated tests (names in IMPLEMENTATION_PLAN): 25-pair transition table; refund property tests (1,000 runs, vendor- and platform-funded) and the same through the API; cap 409 including 5 concurrent refunds (exactly 2 of 5 fit); cancel restocks once (double call, and 3 concurrent cancels); settlement and release-job rules; reconciliation reporting exactly the one tampered transfer.
- **Also run once on a real booted server** (`node src/server.js`, replica set, mock provider, Redis and ES deliberately down): paid order of 300,000 paise → admin partial refund 50,000 (5,000 commission reversed, 45,000 debited) → ship → cancel after ship refused (409) → deliver → vendor settlement shows `pending_release`, net 225,000 → manual release → reconciliation `ok` with provider remaining 225,000 → over-refund refused (409).

**Not verified (do not assume these work):**

1. **Anything against real Razorpay.** The adapter's new calls are tested only against stubbed responses built from the documentation (S20-S22). Run TESTING section 4 with the additions there.
2. **Refunding before release (A6).** Whether a reversal of a transfer still on hold is accepted, and what balance it draws on, is undocumented in the pages I read. If Razorpay refuses it, a refund before release stays `initiated` forever and shows in the reconciliation report. This decides whether the design needs another approach (for example releasing the hold first).
3. **The transfer webhook body path** `payload.transfer.entity.id` (A11) and that `amount_reversed` is returned (A13).
4. A real-browser pass of the three changed pages (no component tests exist; compiled, linted and the helpers unit-tested only).
5. Real Redis and Elasticsearch behaviour after stock is restored by a cancel (cache invalidation and the search outbox run, but only with both services down).

## Known issues

- **Refund steps are not atomic at the provider.** Razorpay has no idempotency key for a reversal. If the process dies after the provider accepts a reversal but before `providerReversalId` is saved, the retry reverses again (the vendor is debited twice). The window is tiny and the reconciliation report would show `transfer_remaining_mismatch`, but nothing repairs it. Same shape as A10 for refunds.
- **A refund Razorpay finally refuses** (`failed`) is not unwound: the vendor may already have been reversed and the customer not refunded. It is logged (`refund.failed_needs_manual_action`) and reported, and there is no admin retry or cancel endpoint yet.
- A `failed` settlement is final; there is no retry path. A crash between flipping a settlement to `released` and the provider call leaves it `released` while still on hold (reported as `hold_not_released`).
- D57 5: refunds whose vendor share is 1-99 paise are refused (open question 4). D57 and open question 1: platform-funded coupon leak.
- A paid order's coupon is never released on cancel (open question 2). Product `soldCount` is not maintained (no code does, before or after this phase).
- Reconciliation fetches transfers one by one (at most 1,000 per run), so it is slow for a large marketplace; it needs batching or a provider list call in Phase 9.
- `settlement.processed` is acknowledged and ignored (A12); `settled` comes from the hourly sweep or `transfer.processed`, so it can lag by up to an hour when no webhook arrives.
- Vendor orders page shows the first 50 only (no paging control). No admin UI for refunds, settlements or reports (Phase 8); they are API-only.
- Carried over from Phase 5: operational prerequisite of linked accounts (D49); A1, A2, A4, A5, A8-A10 unchecked; `payment.failed` does not set `paymentStatus`; MockLedger is in memory; order numbers can have gaps; no address management UI; Phase 3 items.

## Next-phase prerequisites (Phase 7: Reviews and invoices)

- Review and approve Phase 6 (D57-D60), answer the five open questions, then create the branch.
- Do the manual test-mode run, **especially a refund while the transfer is on hold**, before relying on refunds against real Razorpay; record it in `docs/PAYMENT_TEST_LOG.md`.
- Reviews need `delivered` sub-orders: `fulfillmentStatus: delivered` and the product in `items` (a refunded delivered sub-order still counts unless you decide otherwise).
- Invoices need paid orders only; the order's `refundStatus` and each sub-order's `refundedPaise` are now maintained, so an invoice can show refunds.
- Phase 8's "every admin mutation is audited" route-table test: this phase audits refund, manual settlement release and reconciliation run; vendor and admin mutations from earlier phases are unchanged.
