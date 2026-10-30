# DECISIONS.md

Format: Decision · Alternatives · Reason · Verify?

**D1 Modular monolith.** Alt: microservices. Single deployable, shared transactions (orders + stock + coupons), far less ops for a solo portfolio project; module boundaries (service layer only) keep a later split possible.

**D2 Razorpay Route (test mode) as the implemented provider; Stripe Connect documented only.** Alt: Stripe Connect. Stripe's India availability for marketplaces is restricted per its support documentation, so it is a poor default for an India-based demo. Provider hidden behind `PaymentProvider`. **Verify V1-V3.** Fallback: `MockLedgerProvider`.

**D3 Order + SubOrder split.** Alt: one order with per-item vendor status. Per-vendor status, refunds, commission and settlement all key off a vendor slice, so it must be a first-class document.

**D4 Separate payment / refund / settlement states.** Alt: one status enum. They progress independently (a paid order can be partially refunded while settlement is pending); one enum would create impossible-state combinations.

**D5 Money as integer paise.** Alt: decimal/float. Eliminates float errors; rate math uses integers and one explicit rounding step.

**D6 Commission model.** Rate resolution: vendor override → category default → platform default (1000 bps = 10%, configurable). Rate snapshotted on the sub-order at checkout, so later changes never alter history.

- Base for vendor-funded discounts (vendor coupons): `base = subtotal - discount`; `commission = roundHalfUp(base × rateBps / 10000)`; `vendorPayout = base - commission`.
- Platform-funded discounts (admin coupons): customer pays `subtotal - discount`, but `base = subtotal`; vendor payout and commission are unaffected; platform net = `commission - discount` (may be negative, by design).
- Discount allocation across items/vendors: proportional to line subtotal using the largest-remainder method so allocated amounts sum exactly to the total. Rounding happens once per sub-order. Gateway fees borne by the platform (assumption).

**D7 Inventory reserved at checkout via atomic conditional decrement, with a 15-minute expiry.** Alt: decrement at payment; optimistic locking with version field; Redis locks. Decrement-at-payment risks overselling after the customer has paid. Redis locks add a second source of truth. Conditional update inside a Mongo transaction is simple and race-free. Cost: unpaid carts can briefly hold stock.

**D8 Idempotent payment confirmation via status-guarded update.** Three confirmation paths converge on one `markOrderPaid` guarded by `status: pending_payment`. Webhook de-dupe is an additional unique-index on event ID, not the only guard.

**D9 Refund commission reversal is proportional.** `commissionReversed = roundHalfUp(refund × commission.amountPaise / customerTotalPaise)`; the final refund that exhausts the sub-order uses the remainder (`commission - alreadyReversed`) so totals reconcile exactly. Vendor payout reduces by `refund - commissionReversed`. Alt: platform keeps commission on refunds (rejected: penalizes vendors unfairly for platform-approved refunds).

**D10 Settlement hold until delivery + 7-day return window.** Alt: immediate payout at capture. Hold protects against refunds after a vendor has been paid. Depends on provider hold support (**verify V2**); otherwise MockLedger simulates it.

**D11 Elasticsearch synced via transactional outbox.** Alt: Mongo change streams; dual-write in request path; periodic full reindex. Outbox guarantees at-least-once delivery without losing events if ES is down, and works the same everywhere; external versioning prevents stale overwrites; reindex is the repair tool. Change streams add operational requirements and weaker retry semantics.

**D12 Mongo text-index fallback for search.** Keeps the site functional if ES is down or if free ES hosting is unavailable at deploy time (**verify V4**). ES remains the primary and required component.

**D13 Redis is cache-only, fail-open.** Alt: Redis for carts/sessions/stock. Nothing durable in Redis means Redis loss is only a performance event. Auth rate limiter degrades to in-process rather than disabling.

**D14 Auth: short-lived access JWT + rotating httpOnly refresh cookie.** Alt: JWT in localStorage; server sessions. In-memory access token avoids XSS-readable storage; rotation with reuse detection limits stolen-token impact. Cross-site cookie constraints (**verify V5**); preferred mitigation is same parent domain.

**D15 Vendor ownership enforced in the service layer with 404 on mismatch.** Alt: controller-only checks; 403. Central service enforcement means any caller (route or job) is covered; 404 avoids confirming existence.

**D16 One shop per vendor user; single `role` field.** Simplicity. Alt: multi-role/multi-shop (deferred).

**D17 Background jobs in-process with Mongo lease locks.** Alt: BullMQ on Redis; separate worker service. Redis-based queues would make Redis durable-critical, contradicting D13; extra service adds deploy cost. Revisit if load demands.

**D18 No guest cart, no email verification, no variants, free shipping.** Scope control for a demonstrable MVP; each can be added later without schema breakage (reserved `shippingPaise`).

**D19 Invoices generated on demand with pdfkit; not GST-compliant.** Alt: store PDFs in S3; compliant tax invoicing. Storage not needed for deterministic output; compliance out of scope (**verify V6** before any real use).

**D20 JavaScript (ESM) + Zod, not TypeScript.** Matches current stack; Zod gives runtime validation at boundaries. TypeScript can be adopted later; say if you want it from the start.

**D21 Coupon reservation at checkout, redemption at payment.** Prevents a single-use coupon being used twice concurrently; released on expiry/cancel.

**D22 ESLint pinned to major version 9.** Use ESLint `^9.0.0` (or the exact approved ESLint 9 version) for linting. Alt: upgrade automatically to a newer major version. Keeping ESLint on major version 9 avoids unplanned configuration and tooling changes. Verify the installed version and configuration compatibility.

**D23 Environment loading via Node.js `--env-file`.** Start the backend using Node.js's built-in `--env-file` option to load environment variables from the selected environment file. Alt: load environment files through a separate library such as `dotenv`. This avoids an additional runtime dependency and keeps environment loading at the process startup level. Verify the startup scripts, required `NODE_ENV`, and behavior when environment files are missing.

**D24 Login rate limiting counts every attempt.** Use a custom login limiter that counts every login attempt, not only failed attempts. Alt: count only failed attempts or rely on a generic rate limiter. Counting every attempt applies the limit consistently to all login traffic. Verify that successful and failed login attempts both increment the counter.

**D25 Structural role guard in `app.js`.** Enforce role-based access through a structural role guard mounted in `app.js`. Alt: scatter role checks across individual controllers and handlers. Centralized route-level enforcement makes access rules consistent and reduces the risk of accidentally exposing protected routes. Verify that each protected route is mounted behind the appropriate role guard and that public routes remain accessible.

**D26 Refresh returns the session; client refresh is single-flight.** The refresh endpoint returns `{ user, accessToken }`, and the client uses a single-flight mechanism so concurrent requests share one in-progress refresh operation. Alt: return only a new access token and allow each failed request to trigger its own refresh. Returning the session keeps the client’s authentication state synchronized, while single-flight refresh avoids competing refresh requests when refresh-token rotation is enabled. Verify the response contract, concurrent-request behavior, and refresh-token rotation.

**D27 Minimum bcrypt cost is 12.** Enforce a minimum `BCRYPT_COST` of 12, even if a lower value is configured. Alt: accept any configured bcrypt cost. A minimum cost prevents the application from silently using a weaker password-hashing work factor. Verify that values below 12 are rejected or safely raised to 12, and that valid values of 12 or higher work correctly.

**D28 Vendor identity is looked up per request.** Resolve the authenticated vendor's identity from the database on each request rather than relying on potentially stale vendor data embedded in the access token. Alt: trust vendor identity claims from the JWT. This ensures vendor access uses current database state.

**D29 S3 is optional at application boot.** The application must start even when S3 is not configured; image upload operations return HTTP 503 when S3 is unavailable or unconfigured. Alt: fail application startup without S3 configuration. This allows development and deployment without requiring image storage immediately.

**D30 Admin mutations are audited starting in Phase 2.** Record administrative mutation actions in the audit log from Phase 2 onward. Alt: introduce audit logging in a later phase. This provides traceability for administrative changes.

**D31 Stock changes only through the stock endpoint.** Inventory adjustments must go through the dedicated stock endpoint rather than general product update operations. Alt: allow stock quantities to be modified through product CRUD. This keeps inventory changes controlled and prevents accidental stock modifications.

**D32 Shop logos share the `products/{vendorId}/` S3 prefix.** Store shop logo objects under the same vendor-specific S3 prefix used for product images. Alt: use a separate prefix for shop logos. This simplifies vendor-scoped object storage and ownership checks.
