# HANDOVER.md

## Current state (after Phase 4: Cart + coupons)

Phase 4 is implemented. Branch suggestion: `phase-4-cart-coupons`. No Phase 5+ code exists (no checkout, orders, payments, or coupon reservation). Phases 1-3 behave as before.

- **Cart (customers only):** `GET /cart`, `PUT|DELETE /cart/items/:productId`, `DELETE /cart`, `POST|DELETE /cart/coupon`. The cart stores only `productId` + `quantity` (+ `couponCode`). Every response is the whole priced preview, read from Mongo (never cache or search index). Max 10 per product (422 above), max 30 distinct products (409).
- **Preview lines:** `status: ok | insufficient_stock | unavailable`. `unavailable` (product not `active` or shop not `approved`) is shown but not priced or counted. `insufficient_stock` is priced, carries `available`, and sets `hasIssues`. Totals: `total = subtotal - discount` (shipping 0). Each line has `discountPaise` and `lineNetPaise` (ready for the Phase 5 sub-order snapshot).
- **Add rules:** a product that cannot be bought (draft/archived/suspended/unapproved shop/non-existent id) is 409 `CONFLICT`; quantity above current stock is 409 `OUT_OF_STOCK` with `details: [{productId, available}]`.
- **Coupons:** vendor CRUD (`/vendor/coupons`, approved shop, own coupons only, 404 otherwise) and admin CRUD (`/admin/coupons`, platform coupons only, audited as `coupon.created` / `coupon.updated`). `code`, `type`, `scope`, `vendorId`, `usedCount` are not editable.
- **Coupon validation:** one pure function, `evaluateCoupon` in `modules/coupons/coupons.rules.js` (no DB, no clock). Returns `{ ok:false, reason }` or `{ ok:true, discountPaise, lineDiscounts }`. Percent uses `roundHalfUp`, optional `maxDiscountPaise` cap (percent only), clamp to covered subtotal; allocation to lines uses largest remainder (`lib/money.js`) so shares sum exactly. A vendor coupon covers only that vendor's lines; `minOrderPaise` is measured on covered lines.
- **Saved coupon:** `POST /cart/coupon` saves only a coupon valid right now (else 422 `COUPON_INVALID`, `details.reason`; the previous coupon is kept). On later reads the coupon is re-evaluated; if it stopped being valid the cart still answers 200 with `coupon: null`, `couponError: {code, reason}` and no discount.
- **Client:** `/cart` page (customers; quantity select, remove, empty, coupon apply/remove, totals, warnings), "Add to cart" on the product page (adds to the existing quantity, capped at 10; login hint for anonymous users), header "Cart (n)" link for customers. There is no vendor/admin coupon UI yet (API only) and no checkout button (Phase 5).

## Key decisions (proposed additions to DECISIONS.md: D39-D43, already drafted in the updated DECISIONS.md)

- **D39** Cart stores ids + quantities only; reads price from Mongo; unavailable lines excluded from totals, insufficient-stock lines flagged.
- **D40** Adding is strict (409/422), the preview only warns; cart writes are atomic single updates (no lost or duplicate lines under parallel requests).
- **D41** Coupon rules are one pure function; check order, min-order-on-covered-lines, percent cap, clamp, largest-remainder allocation.
- **D42** Coupon CRUD immutability, approved-shop requirement, 404 ownership, admin audit actions.
- **D43** Saved cart coupon is re-evaluated on every read and reported as `couponError`, not as an error response.

## Relevant files

New (server): `src/lib/money.js` (`mulDivRoundHalfUp`, `allocateProportionally`); `src/modules/cart/` (`cart.model`, `.validator`, `.service`, `.controller`, `.routes`); `src/modules/coupons/` (`coupons.model`, `redemptions.model`, `coupons.rules`, `.validator`, `.service`, `.controller`, `.routes`); `tests/phase4.unit.test.js`, `tests/cart.test.js`, `tests/coupons.test.js`.
New (client): `src/lib/cart.js` (+ `cart.test.js`), `src/components/AddToCart.jsx`, `src/pages/CartPage.jsx`, `src/pages/cart.css`.
Changed: `server/src/app.js` (wiring), `server/src/config/constants.js` (`CART`, `COUPON`, `COUPON_REASONS`), `server/tests/db.js` (new models in cleanup), `server/tests/rbac.test.js` (Phase 4 routes in the route-table guard), `client/src/App.jsx`, `client/src/components/Layout.jsx`, `client/src/pages/ProductPage.jsx`.
Dependencies: dev-only `fast-check` in `server` (the property-test tool named in TESTING.md).

## API changes

| Method    | Path                              | Auth              | Notes                                                                    |
| --------- | --------------------------------- | ----------------- | ------------------------------------------------------------------------ |
| GET       | `/cart`                           | Customer          | priced preview                                                           |
| PUT       | `/cart/items/:productId`          | Customer          | `{ quantity }` 0-10; 0 removes; 422 >10; 409 `CONFLICT`/`OUT_OF_STOCK`   |
| DELETE    | `/cart/items/:productId`, `/cart` | Customer          | idempotent                                                               |
| POST      | `/cart/coupon`                    | Customer          | `{ code }`; 422 `COUPON_INVALID` `details.reason`                        |
| DELETE    | `/cart/coupon`                    | Customer          | idempotent                                                               |
| GET/POST  | `/vendor/coupons`                 | Vendor (approved) | list own (`status`, `page`, `limit`) / create; 403 `VENDOR_NOT_APPROVED` |
| GET/PATCH | `/vendor/coupons/:couponId`       | Vendor (approved) | other vendors' ids: 404                                                  |
| GET/POST  | `/admin/coupons`                  | Admin             | platform coupons only; create audited                                    |
| GET/PATCH | `/admin/coupons/:couponId`        | Admin             | update audited                                                           |

Response shapes and reasons are documented in the updated API_CONTRACTS.md.

## Schema changes

New collections: `carts` (`customerId` unique, `items[{productId, quantity 1-10, addedAt}]` max 30, `couponCode?`), `coupons` (fields and indexes as in DATABASE_SCHEMA; `usageLimitPerUser` defaults to 1, `minOrderPaise` to 0), `couponRedemptions` (model exists and is READ by the per-user limit check; nothing writes it until Phase 5). New audit actions `coupon.created`, `coupon.updated` (entityType `coupon`).

## Environment variables

None new.

## Verification

Run in a sandbox with real MongoDB 8.3.7 (single-node replica set via mongodb-memory-server with a system binary). **No real Redis or Elasticsearch was used** (Phase 4 does not touch them; the cart never reads the cache or index).

- Server: 409 tests pass (308 existing + 101 new). Client: 55 tests pass (50 existing + 5 new); `vite build` OK. ESLint clean; Prettier clean.
- Acceptance: quantity >10 is 422, non-purchasable is 409, archived product shows `unavailable` in the preview; coupon validation table covers the 10 plan cases (+ extras) and integration tests cover the API reasons; the 1,000-run property tests verify that coupon line shares sum exactly to the discount (and that allocation is exact and bounded).
- Parallel cart writes (6 different products into a new cart at once; the same product repeatedly) leave no lost and no duplicate lines.

**Not verified:**

1. A real browser pass of the cart UI, add-to-cart on the product page, and the header link (components are only compiled by `vite build` and linted; there are no component tests).
2. The outstanding Phase 3 checks that need your Docker stack (real ES mapping/relevance, 10 s search latency p95, `npm run reindex` on 1,000 products, cached product p95 < 50 ms) remain open as listed in the previous handover.
3. Behavior against a real Redis for the cart (not used by this phase).

## Known issues

- A `fixed` coupon (or a stack of one) can clamp a cart total to **0**. Payment providers will not create a 0-amount order, so Phase 5 must decide: reject a 0 total at checkout, or skip the provider for zero-total orders.
- Coupon usage limits become effective only when checkout writes `couponRedemptions` and increments `usedCount` (Phase 5). Until then the checks are exercised by tests that insert rows directly.
- Coupon-code guessing is limited only by the global rate limiter (300 requests / 15 min / IP). No dedicated limiter was added because none is specified in ARCHITECTURE section 8; consider one in Phase 9.
- No TTL/cleanup for abandoned carts.
- No vendor or admin coupon UI; manage coupons through the API.
- Carried over from Phase 3: category rename/re-parent/deactivation is not propagated to the index; reindex runs inside the HTTP request; `inStock` in search can be up to ~60 s stale; Mongo fallback loads all approved shops; API_CONTRACTS says a `rejected` vendor is terminal while code/constants allow `rejected -> approved`; two Phase 2 acceptance boxes (presign constraints; negative stock / non-integer price) are still unticked in IMPLEMENTATION_PLAN and were not touched in this phase.

## Next-phase prerequisites (Phase 5: Checkout, inventory, payments)

- Review and approve Phase 4, then create the branch.
- **Gate:** V1, V2, V3 (Razorpay Route behavior: holds, webhook payloads, test-mode capabilities) must be resolved before starting Phase 5.
- Checkout must re-read price, stock and coupon from Mongo and re-run `evaluateCoupon` inside the transaction; reuse `lineDiscounts` for sub-order item snapshots (`discountPaise`, `lineNetPaise`); write `couponRedemptions(reserved)` and increment `usedCount` conditionally in that same transaction (D21); clear the cart on success.
- Decide the zero-total order behavior (see Known issues).
- Mount the raw-body webhook route before `express.json` in `app.js` (marked there).
