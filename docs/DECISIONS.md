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
