# DATABASE_SCHEMA.md

Conventions: Mongoose `timestamps: true`; `_id` ObjectId; money in `...Paise` ints (validated `Number.isInteger && >= 0`); enums lowercase snake_case; `ref` = ObjectId reference. All string inputs trimmed.

## users

| Field | Type | Rules |
| ------------ | -------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------- |
| email | String | required, lowercase, unique, email format |
| passwordHash | String | required, `select:false` |
| name | String | required, 2-80 |
| phone | String | optional, E.164-ish regex |
| role | String | enum `customer                                                                                              | vendor                       | admin`, default `customer` |
| status | String | enum `active                                                                                                | suspended`, default `active` |
| addresses[] | embedded | max 5: `{ label, name, phone, line1, line2?, city, state, postalCode (6 digits), country:'IN', isDefault }` |
| lastLoginAt | Date | |

Indexes: `{email:1}` unique; `{role:1,status:1}`.

## refreshTokens

`userId (ref users)`, `tokenHash` (SHA-256, unique), `familyId`, `expiresAt`, `revokedAt?`, `replacedByHash?`, `userAgent`, `ip`.
Indexes: `{tokenHash:1}` unique; `{userId:1}`; `{familyId:1}`; TTL on `{expiresAt:1}` (expireAfterSeconds 0).

## vendors (shops)

| Field | Type | Rules |
| ----------------- | --------- | ------------------------------------------------------------- | -------- | -------- | ---------------------------------------------------- |
| userId | ref users | unique, role must be vendor |
| shopName | String | 3-60, required |
| shopSlug | String | unique, lowercase kebab |
| description | String | ≤ 1000 |
| logoKey | String | S3 key under `products/{vendorId}/` |
| status | String | `pending                                                      | approved | rejected | suspended`, default `pending` |
| commissionRateBps | Number | nullable override, int 0-5000 |
| payoutAccount | embedded | `{ provider:'razorpay', linkedAccountId?, status:'not_created | pending  | active   | failed', bankLast4? }` (no full bank numbers stored) |

Indexes: `{userId:1}` unique; `{shopSlug:1}` unique; `{status:1}`.

## categories

`name`, `slug` (unique), `parentId?` (max depth 2), `defaultCommissionBps?` (0-5000), `isActive`, `sortOrder`.
Indexes: `{slug:1}` unique; `{parentId:1,sortOrder:1}`.

## products

| Field | Type | Rules |
| ------------------- | ------------------ | ------------------------------------------------------ | ------ | -------- | ---------- |
| vendorId | ref vendors | required |
| title | String | 3-150 |
| slug | String | unique (title + short id) |
| description | String | ≤ 5000 |
| categoryId | ref categories | required, must be leaf-or-any active |
| pricePaise | Number | int ≥ 100 |
| compareAtPricePaise | Number | optional, > pricePaise |
| sku | String | unique per vendor |
| stockQty | Number | int ≥ 0 |
| images[] | `{ key, alt? }` | 1-6 items, keys must start with `products/{vendorId}/` |
| attributes | Map<String,String> | ≤ 10 entries |
| status | String | `draft                                                 | active | archived | suspended` |
| ratingAvg | Number | 0-5, default 0 |
| ratingCount | Number | int ≥ 0 |
| soldCount | Number | int ≥ 0 |

Indexes: `{slug:1}` unique; `{vendorId:1,sku:1}` unique; `{vendorId:1,status:1,createdAt:-1}`; `{categoryId:1,status:1,pricePaise:1}`; text index `{title:'text',description:'text'}` (search fallback).
Rule: a product is publicly visible only if `status='active'` and its vendor is `approved`.

## carts

`customerId` (unique), `items[]: { productId, quantity (1-10), addedAt }`, `couponCode?`. No prices stored. Indexes: `{customerId:1}` unique. Max 30 items.

## orders

| Field | Type | Rules |
| ------------------------------------------------------- | ----------------- | ------------------------------------------------------------ | ----------------------------------- | ---------------------------- | --------- | -------- |
| orderNumber | String | unique `MP-YYYYMMDD-NNNNNN` (from `counters`) |
| customerId | ref users | |
| status | String | `pending_payment                                             | placed                              | completed                    | cancelled | expired` |
| paymentStatus | String | `unpaid                                                      | paid                                | failed` |
| refundStatus | String | `none                                                        | partial                             | full` (aggregate of refunds) |
| currency | String | `INR` |
| shippingAddress | embedded snapshot | copy of address at checkout |
| subtotalPaise, discountPaise, shippingPaise, totalPaise | Number | `total = subtotal - discount + shipping` (shipping 0 in MVP) |
| coupon | embedded | `{ couponId, code, fundedBy:'vendor                          | platform', discountPaise }` or null |
| reservationExpiresAt | Date | set while `pending_payment` |
| idempotencyKey | String | unique per customer |
| paymentId | ref payments | |
| placedAt | Date | set by markOrderPaid |

Indexes: `{orderNumber:1}` unique; `{customerId:1,createdAt:-1}`; `{customerId:1,idempotencyKey:1}` unique; `{status:1,reservationExpiresAt:1}` (partial: status=pending_payment); `{createdAt:-1}`.

## subOrders

| Field | Type | Rules |
| ------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------- | --------- | ---------- |
| subOrderNumber | String | `orderNumber-V{n}` |
| orderId, customerId, vendorId | refs | |
| items[] | embedded snapshot | `{ productId, title, sku, imageKey, unitPricePaise, quantity, lineSubtotalPaise, discountPaise, lineNetPaise }` |
| subtotalPaise | Number | sum of `lineSubtotalPaise` |
| discountPaise | Number | allocated coupon discount |
| shippingPaise | Number | 0 in MVP |
| customerTotalPaise | Number | what the customer pays for this slice (`subtotal - discount + shipping`) |
| commission | embedded | `{ rateBps, rateSource:'vendor                                                                                  | category   | platform', amountPaise, basePaise }` snapshot |
| vendorPayoutPaise | Number | payout before refund adjustments |
| fulfillmentStatus | String | `pending_payment                                                                                                | processing | shipped                                       | delivered | cancelled` |
| refundStatus | String | `none                                                                                                           | pending    | partial                                       | full      | failed` |
| refundedPaise | Number | sum of refunds in `initiated` or `processed`, reserved when the refund is created (D57) |
| stockRestored | Boolean | guard against double restock |
| tracking | embedded | `{ carrier?, trackingNumber? }` |
| statusHistory[] | `{ status, at, byUserId, note? }` | append-only |
| deliveredAt, returnWindowEndsAt | Date | |

Indexes: `{orderId:1}`; `{vendorId:1,fulfillmentStatus:1,createdAt:-1}`; `{customerId:1,createdAt:-1}`; `{subOrderNumber:1}` unique; `{returnWindowEndsAt:1}` (partial: delivered).
Invariant: `sum(subOrders.customerTotalPaise) == order.totalPaise`.

## payments

`orderId`, `provider: razorpay|mock`, `providerOrderId` (unique, sparse: the row is written inside the checkout transaction and the provider order is created after the commit), `providerPaymentId` (unique, sparse), `amountPaise`, `currency`, `status: created|authorized|captured|failed`, `method?`, `failureReason?`, `capturedAt?`, `confirmedVia?: client_verify|webhook|reconcile`.
Indexes: `{providerOrderId:1}` unique; `{providerPaymentId:1}` unique sparse; `{orderId:1}`.

## refunds

`paymentId`, `orderId`, `subOrderId?` (absent for an order-level `failed_late_capture` refund), `amountPaise`, `commissionReversedPaise`, `vendorDebitPaise`, `reason` (enum `customer_cancel|vendor_cancel|admin|failed_late_capture`), `note?`, `status: initiated|processed|failed`, `providerRefundId` (unique sparse), `providerReversalId?` (the vendor transfer reversal made for this refund, kept so a retry never repeats it, D57), `providerCallAt?` (atomic claim of the provider call, 60 s), `requestedBy?` (absent when the system refunds), `idempotencyKey` (unique). `commissionReversedPaise` follows D9; `vendorDebitPaise` is calculated proportionally from the original `vendorPayoutPaise` and `customerTotalPaise`, with the final refund taking the remaining vendor payout (D57). For platform-funded coupons this is intentionally not always `amountPaise - commissionReversedPaise`.
Indexes: `{subOrderId:1}`; `{providerRefundId:1}` unique sparse; `{idempotencyKey:1}` unique.
Rules: `sum(refunds.amountPaise where status in initiated|processed) <= subOrder.customerTotalPaise`; a calculated `vendorDebitPaise` of 1-99 paise is rejected before writes/provider calls, while 0 is allowed. `vendorDebitPaise` values are accumulated into `settlements.refundAdjustmentPaise`.

## settlements

`subOrderId` (unique), `orderId`, `vendorId`, `grossPaise` (vendor base before commission), `commissionPaise`, `refundAdjustmentPaise`, `netPayoutPaise`, `status: not_eligible|pending_release|released|settled|reversed|failed`, `providerTransferId?`, `eligibleAt?`, `releasedAt?`, `settledAt?`, `failureReason?`.
Indexes: `{subOrderId:1}` unique; `{vendorId:1,status:1,createdAt:-1}`; `{status:1,eligibleAt:1}`.
Rule: `netPayoutPaise = grossPaise - commissionPaise - refundAdjustmentPaise`, floor 0. `refundAdjustmentPaise` is the sum of `vendorDebitPaise` for the sub-order's refunds. Admin manual release may bypass the 7-day return window only; all other release guards still apply (D59). Reconciliation reports mismatches but never mutates financial records (D60). Transitions (D59): `not_eligible` -> `pending_release` | `reversed`; `pending_release` -> `released` | `reversed` | `failed`; `released` -> `settled` | `failed`; `settled`, `reversed`, `failed` are final.

## coupons

| Field | Rules |
| ----------------------------------- | --------------------------------------------------------- | --------- |
| code | unique, uppercase `[A-Z0-9_-]{4,20}` |
| scope | `platform` or `vendor`; vendor coupons require `vendorId` |
| fundedBy | `platform` for platform scope; `vendor` for vendor scope |
| type, value | `percent` (1-90) or `fixed` (paise ≥ 100) |
| minOrderPaise, maxDiscountPaise? | ints; `minOrderPaise` defaults to 0 and is measured on the lines the coupon covers; `maxDiscountPaise` is allowed on `percent` coupons only |
| startsAt, expiresAt | expiresAt > startsAt |
| usageLimitTotal?, usageLimitPerUser | ints ≥ 1; `usageLimitTotal` unset = unlimited; `usageLimitPerUser` defaults to 1 |
| usedCount | int, maintained atomically |
| status | `active                                                   | disabled` |

Indexes: `{code:1}` unique; `{vendorId:1}`.

## couponRedemptions

`couponId`, `customerId`, `orderId`, `discountPaise`, `status: reserved|redeemed|released`. An unpaid reservation may become `released` on expiry/cancellation; once `redeemed` after payment, it remains consumed even if the paid order or a sub-order is later cancelled or refunded (D21/D57). Indexes: `{couponId:1,orderId:1}` unique; `{couponId:1,customerId:1,status:1}`.

## reviews

`productId`, `vendorId`, `customerId`, `subOrderId`, `rating` (int 1-5), `title?` (≤100), `body` (10-2000), `status: published|hidden`. A delivered purchase remains eligible after a full refund; hard deletion permits re-review with a new 30-day edit window; editing a hidden review does not republish it (D61). `ratingAvg/ratingCount` on `products` are recomputed from `published` rows and `ratingAvg` is stored to 2 decimal places (D62). Indexes: `{customerId:1,productId:1}` unique; `{productId:1,status:1,createdAt:-1}`.

## invoices

`orderId` (unique), `invoiceNumber` (unique, `INV-YYYY-NNNNNN` from counters), `generatedAt`. PDF is generated on demand from order data (not stored); platform name is the generic constant `Marketplace` for now (D63). Implemented Phase 7 (D63); indexes `{orderId:1}` unique, `{invoiceNumber:1}` unique; the year in the number is the UTC year of generation.

## Supporting collections

- `counters`: `{ _id:'orderNumber:YYYYMMDD' | 'invoice:YYYY', seq }` via `$inc` upsert.
- `webhookEvents`: `provider, eventId (the x-razorpay-event-id header; unique with provider), eventType, status: received|processed|failed|ignored, attempts, receivedAt, claimedAt, processedAt?, error?`; TTL 90 days on `receivedAt`. `claimedAt` is when a handler last took ownership of the event (atomic claim, DECISIONS D46).
- `searchOutbox`: `productId, op:'upsert|delete', attempts, nextAttemptAt, lastError?, createdAt`; indexes `{nextAttemptAt:1}` and `{productId:1}`.
  `op` is advisory; the sync job determines whether to index or delete using the current product and vendor state.
- `auditLogs`: `actorId, actorRole, action, entityType, entityId, meta, createdAt`; written by admin mutations for `vendor.status_changed`, `vendor.commission_changed`, `category.created`, `category.updated`, and `search.reindexed`, `review.status_changed` (`meta { from, to, productId }`), `coupon.created`, `coupon.updated`, `product.status_changed` (Phase 8, `meta { from, to, vendorId }`), and `vendor.payout_account_attached` (written by the `link-account` admin script, `meta { previousLinkedAccountId, linkedAccountId }`); index `{entityType:1,entityId:1,createdAt:-1}`.
- `reconciliationReports`: `runAt`, `status` (`ok|mismatch`), `trigger` (`job|admin`), `triggeredBy?` (reports only; reconciliation is read-only and does not correct financial records, D60), `totals{settlementsChecked, skippedOpenRefund, localNetPayoutPaise, providerRemainingPaise, mismatchCount, truncated}`, `mismatches[]` (`type, entityType, settlementId?, refundId?, subOrderId?, providerTransferId?, expected?, actual?, detail?`; at most 200 stored). Index `{runAt:-1}`. Types: see D60.
- `jobLocks`: `{ _id: jobName, lockedUntil, owner }`.

## Relationship summary

users 1-1 vendors; vendors 1-N products; categories 1-N products; users 1-1 carts; users 1-N orders; orders 1-N subOrders; orders 1-1 payments (MVP); subOrders 1-1 settlements; subOrders 1-N refunds; products 1-N reviews; coupons 1-N couponRedemptions.

## Example documents

```json
// users
{ "_id": "66f0...a1", "email": "asha@example.com", "name": "Asha K", "role": "customer", "status": "active",
  "addresses": [{ "label": "Home", "name": "Asha K", "phone": "+919876543210", "line1": "12 Lake Rd", "city": "Kochi",
                  "state": "Kerala", "postalCode": "682001", "country": "IN", "isDefault": true }] }

// products
{ "_id": "66f1...b2", "vendorId": "66f0...c3", "title": "Handloom Cotton Kurta", "slug": "handloom-cotton-kurta-x7k2",
  "categoryId": "66ef...d4", "pricePaise": 149900, "sku": "KRT-001", "stockQty": 25,
  "images": [{ "key": "products/66f0...c3/9f2a.webp", "alt": "Front view" }],
  "status": "active", "ratingAvg": 4.6, "ratingCount": 12, "soldCount": 40 }

// subOrders (vendor-funded coupon, 10% commission)
{ "subOrderNumber": "MP-20261025-000123-V1", "orderId": "66f2...e5", "vendorId": "66f0...c3",
  "items": [{ "productId": "66f1...b2", "title": "Handloom Cotton Kurta", "sku": "KRT-001", "unitPricePaise": 149900,
              "quantity": 2, "lineSubtotalPaise": 299800, "discountPaise": 29980, "lineNetPaise": 269820 }],
  "subtotalPaise": 299800, "discountPaise": 29980, "shippingPaise": 0, "customerTotalPaise": 269820,
  "commission": { "rateBps": 1000, "rateSource": "platform", "amountPaise": 26982, "basePaise": 269820 },
  "vendorPayoutPaise": 242838, "fulfillmentStatus": "processing", "refundStatus": "none", "refundedPaise": 0 }

// settlements
{ "subOrderId": "66f3...f6", "vendorId": "66f0...c3", "grossPaise": 269820, "commissionPaise": 26982,
  "refundAdjustmentPaise": 0, "netPayoutPaise": 242838, "status": "pending_release",
  "providerTransferId": "trf_TEST123", "eligibleAt": "2026-11-05T10:00:00Z" }

// webhookEvents
{ "provider": "razorpay", "eventId": "evt_TEST456", "eventType": "order.paid", "status": "processed", "attempts": 1 }
```

## Phase 8 index changes

No new collection and no new field. Two indexes were added: `orders {paymentStatus:1, placedAt:-1}` (analytics read paid orders by payment time) and `reviews {status:1, createdAt:-1}` (the admin moderation list). They are built by `Model.init()` at start-up like the others.
