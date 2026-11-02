# HANDOVER.md

## Current state (after Phase 5: Checkout, inventory, payments)

Phase 5 is implemented. Branch suggestion: `phase-5-checkout-payments`. No Phase 6+ code exists (no fulfilment transitions, customer cancel, admin refund, settlement release, invoices). Phases 1-4 behave as before.

- **Checkout:** `POST /checkout` (customer, `Idempotency-Key` required) re-reads prices, stock and the coupon inside one Mongo transaction, rejects before the first write (empty cart, unavailable, out of stock, coupon, total under 100 paise, vendor without payout account, payout under 100 paise, `exceeds_platform_margin`), then writes the order, one sub-order per vendor, settlements (`not_eligible`), the payment row, the coupon reservation and the stock decrement, and clears the cart. The provider order (with one **on-hold transfer per sub-order**) is created after the commit; on failure the order is expired again and the cart is restored.
- **Confirmation:** `POST /payments/verify` (browser callback), `POST /webhooks/razorpay` and the reconcile job all end in one conditional `markOrderPaid`, so whichever arrives first wins. The signature is checked against the order id **stored** on the server. Payment state always comes from a provider fetch, never from a request body.
- **Webhook:** raw body, HMAC verified over the raw bytes, deduplicated by the `x-razorpay-event-id` header with **atomic claiming** (a `failed` row or a `received` row older than 60 s is taken over by exactly one request). Always 200 for a correctly signed request.
- **Jobs (lease-guarded, every 60 s):** reservation release (expires unpaid orders after 15 min, asking the provider first whether the customer paid) and reconcile (confirms paid orders older than 5 min, checks orders expired in the last hour for late captures, retries refunds the provider refused).
- **Late capture:** an expired order that gets paid re-reserves its stock, or if the stock is gone is refunded in full (one order-level `Refund`, provider call claimed atomically).
- **Providers:** `PaymentProvider` contract; `MockLedgerProvider` (in-process, enforces Razorpay's documented limits) and a Razorpay Route adapter (plain `fetch`, no SDK). `PAYMENT_PROVIDER=mock` is refused in production.
- **Payout accounts:** vendors are paid only with an attached linked account. Create it in the Razorpay Dashboard and attach it with `npm run link-account -- --vendor <id|slug> --account <acc_id> --admin <email> [--replace]` (validated, audited). `POST/GET /vendor/payout-account` are **deferred**. The mock derives `acc_mock<vendorId>` automatically.
- **Client:** `/checkout` (address choice or a small add-address form, summary, place order), `/orders`, `/orders/:orderId` (status, countdown, live refresh, payment panel: Razorpay Checkout or, with the mock, a "Simulate payment" button), "Proceed to checkout" on the cart, "Orders" in the header.

## Key decisions (DECISIONS.md)

D44-D51 **Accepted** (V1-V3 research, holds, webhooks, transfer limits, verify rules, payout accounts, 100-paise minimums, `PLATFORM_COMMISSION_BPS`). **D52-D56 are Proposed and need your review:** D52 commission rate for multi-category sub-orders; D53 checkout details (coupon omitted/null, 201 vs 200, cart restore, order-number gaps); D54 late capture and refunds as built; D55 dev-only mock payment endpoint; D56 schema and naming differences. The source register at the end of that section lists every Razorpay page used, and assumptions A1-A10.

## Relevant files

New (server): `src/lib/commission.js`, `src/lib/modelJson.js`; `src/providers/payment/` (`PaymentProvider.js`, `signatures.js`, `mockLedger.js`, `razorpay.js`, `index.js`); `src/modules/orders/` (`orders.model`, `orders.money`, `orders.lifecycle`, `checkout.service`, `orders.service`, `.validator`, `.controller`, `.routes`); `src/modules/payments/` (`payments.model`, `payments.service`, `webhooks.service`, `.validator`, `.controller`, `.routes`); `src/modules/settlements/settlements.model.js`; `src/modules/refunds/refunds.model.js`; `src/jobs/` (`leasedJob`, `reservationRelease`, `reconcilePending`); `src/scripts/linkAccount.js`; tests `phase5a.unit`, `checkout`, `payments`, `jobs`, `linkAccount`, `razorpay.provider` and `phase5.helpers.js`.
New (client): `src/lib/checkout.js` (+ test), `src/pages/CheckoutPage.jsx`, `OrdersPage.jsx`, `OrderPage.jsx`, `orders.css`.
Changed: `server/src/app.js` (provider, services, raw-body webhook router mounted before the JSON parser), `src/server.js` (provider, index creation, jobs), `src/config/constants.js`, `src/config/env.js`, `src/middleware/rateLimit.js` (checkout limiter), `src/modules/audit/audit.service.js` (optional transaction `session`), `server/package.json` and root `package.json` (`link-account`), `.env.example`, `tests/helpers.js`, `tests/db.js`, `tests/rbac.test.js`; client `App.jsx`, `Layout.jsx`, `CartPage.jsx`, `cart.css`. No new dependencies.

## API changes

New: `POST /checkout` (201 first call, 200 replay), `GET /orders`, `GET /orders/:orderId`, `POST /payments/verify`, `POST /webhooks/razorpay` (outside `/api/v1` auth and rate limits; the signature authenticates), `POST /payments/mock/complete` (dev only, 404 otherwise). Shapes, errors and reasons are in API_CONTRACTS.md. `POST/GET /vendor/payout-account` are marked deferred.

## Schema changes

New collections `orders`, `subOrders`, `payments`, `settlements`, `refunds`, `counters`, `webhookEvents` (see DATABASE_SCHEMA.md, already updated). Differences from the earlier schema: `payments.provider` allows `mock` and `providerOrderId` is unique-sparse; `webhookEvents.claimedAt`; `refunds.subOrderId`/`requestedBy` optional and `providerCallAt`; audit action `vendor.payout_account_attached`. `couponRedemptions` is now written (reserved, redeemed, released) and `usedCount` is maintained.

## Environment variables

New: `PAYMENT_PROVIDER` (`mock` default / `razorpay`; mock refused when `NODE_ENV=production`), `PLATFORM_COMMISSION_BPS` (integer 0-5000, default 1000, empty means unset), `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (required only for `razorpay`). `.env.example` is updated.

## Commands

```
npm install
npm run lint && npx prettier --check .
npm test -w server          # needs a MongoDB replica-set binary (see Verification)
npm test -w client && npm run build -w client
npm run link-account -w server -- --vendor <id|slug> --account <acc_id> --admin <email>
```

## Verification (what was actually run, 2026-11-01)

Environment: Node 22, **real MongoDB 8.3.7** (single-node replica set from a system binary via `MONGOMS_SYSTEM_BINARY`). No Razorpay, Redis or Elasticsearch was used by the tests.

- Server: **563 tests pass** (409 existing + 154 new). Client: **71 tests pass** (55 + 16); `vite build` OK. ESLint clean on the whole repo. Prettier clean on code (see the note on docs below).
- New acceptance checks all pass as automated tests (the list with test names is in IMPLEMENTATION_PLAN Phase 5): 50 concurrent checkouts on stock 10 give 10 orders and 40 `OUT_OF_STOCK` with stock 0; the same key sent 5 times at once gives 1 order and 1 provider order; 1,000-run property tests for commission and totals; tampered signature/amount give 400 with the order unchanged; one webhook delivered 3 times and concurrently with verify changes the order once; 20 concurrent claims of a `failed` or stale `received` event run the handler once; expiry restores stock and coupon exactly once (also under 5 racing calls); late capture re-reserves or refunds exactly once.
- **Also run once on a real booted server** (`node src/server.js`, replica set, mock provider, Redis and ES deliberately down): register customer, two vendors and an admin; vendor-funded coupon; 2-vendor checkout (total 280,000 paise); replay; tampered verify (400) then good verify (placed); signed webhook, duplicate and bad-signature webhook through the real raw-body route; the real reservation job expired a backdated unpaid order and restored the stock (1 to 4); the `link-account` CLI attached, no-op'd, and rejected a wrong account and a non-admin; production boot with the mock exited with an error.

**Not verified:**

1. **A payment with real Razorpay (test mode).** Needs your account: Route enabled, a linked account, auto-capture, a webhook URL Razorpay accepts (not localhost or a blocklisted tunnel), then DECISIONS assumptions A4, A8, A9, A10. The Razorpay adapter is tested against a stubbed `fetch` built from the documentation only.
2. A real-browser pass of the new pages, and Razorpay's widget opening. The components are only compiled and linted; there are no component tests.
3. Behaviour with a real Redis (cache invalidation after stock changes is exercised with no Redis) or Elasticsearch.
4. The outstanding Phase 3 checks that need your Docker stack (see the previous handover) remain open.
5. Prettier on docs: `docs/*.md` were reformatted by Prettier only where Claude edited them; re-run `npx prettier --check .` after pasting.

## Known issues

- **Operational prerequisite:** with `PAYMENT_PROVIDER=razorpay`, a vendor without an attached, active linked account cannot be bought from (409 `vendor_payout_unavailable`). Attach accounts with `link-account` first.
- `exceeds_platform_margin` is checked only at checkout, so a platform coupon can look valid in the cart and be refused at checkout (D47b, by design).
- Whether Route is **activated** for a linked account is not checked (it needs a product id we do not store); a non-activated account appears as a 502 when an order is created (D49).
- The 100-paise minimum per transfer inside an order is assumed from the transfers-from-payments page (A1); the "no transfer above the order amount" rule is read on a non-India page only (A2).
- A failed webhook is answered 200 and recorded `failed`; Razorpay will not retry it. It is recovered by a manual replay (same event id, atomic re-claim) or by the reconcile job, which asks the provider directly. Reconcile looks at an expired order for one hour only.
- If the process dies after the provider accepts a late-capture refund but before the database is updated, the retry asks Razorpay again; Razorpay should refuse a second full refund, but that was not tested (A10).
- `payment.failed` is stored on the payment but never sets `orders.paymentStatus = failed` (the customer may retry on the same provider order).
- MockLedger is in memory: a mock-paid order cannot be confirmed after a server restart (development only).
- Order numbers can have gaps (the counter is taken before the transaction).
- There are no customer cancel, refund, invoice or fulfilment endpoints yet (Phases 6-7); `docs` list them.
- No address management UI other than the add-address form at checkout.
- Carried over: `POST /cart/coupon` has only the global rate limit; no cleanup of abandoned carts; no vendor/admin coupon UI; Phase 3 items (category changes not propagated to the index, reindex runs inside the HTTP request, `inStock` in search up to about 60 s stale, Mongo fallback loads all approved shops); API_CONTRACTS says a `rejected` vendor is terminal while the code allows `rejected -> approved`; two Phase 2 acceptance boxes (presign constraints; negative stock / non-integer price) are still unticked.

## Next-phase prerequisites (Phase 6: Fulfilment, refunds, settlements)

- Review and approve Phase 5 (including D52-D56), then create the branch.
- Read before designing refunds: the Razorpay **transfer reversal API** and whether an **on-hold** transfer can be reversed (A6), and the **official refund webhook** names (A7). A partial refund of a multi-vendor payment cannot use `reverse_all` (D45).
- The settlement release job needs `PATCH /v1/transfers/:id` with `on_hold: false` (D45, S2); `PaymentProvider` has no `releaseTransfer` yet. `settlements.providerTransferId` is already stored at checkout.
- Sub-orders are `processing` once paid and `cancelled` when their order expires; Phase 6 adds `shipped`, `delivered`, customer cancel (stock restored once via `stockRestored`, reuse `orders.lifecycle.restoreStock`) and the settlement states.
- Webhook events for transfers, settlements and refunds must be added to the handler (they are stored as `ignored` today).
- Do the manual test-mode run (TESTING section 4) before relying on any Razorpay behaviour documented here as an assumption.
