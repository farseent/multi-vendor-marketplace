# DATABASE_SCHEMA.md

Conventions: Mongoose `timestamps: true`; `_id` ObjectId; money in `...Paise` ints (validated `Number.isInteger && >= 0`); enums lowercase snake_case; `ref` = ObjectId reference. All string inputs trimmed.

## users

| Field        | Type     | Rules                                                                                                       |
| ------------ | -------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------- |
| email        | String   | required, lowercase, unique, email format                                                                   |
| passwordHash | String   | required, `select:false`                                                                                    |
| name         | String   | required, 2-80                                                                                              |
| phone        | String   | optional, E.164-ish regex                                                                                   |
| role         | String   | enum `customer                                                                                              | vendor                       | admin`, default `customer` |
| status       | String   | enum `active                                                                                                | suspended`, default `active` |
| addresses[]  | embedded | max 5: `{ label, name, phone, line1, line2?, city, state, postalCode (6 digits), country:'IN', isDefault }` |
| lastLoginAt  | Date     |                                                                                                             |

Indexes: `{email:1}` unique; `{role:1,status:1}`.

## refreshTokens

`userId (ref users)`, `tokenHash` (SHA-256, unique), `familyId`, `expiresAt`, `revokedAt?`, `replacedByHash?`, `userAgent`, `ip`.
Indexes: `{tokenHash:1}` unique; `{userId:1}`; `{familyId:1}`; TTL on `{expiresAt:1}` (expireAfterSeconds 0).

## vendors (shops)

| Field             | Type      | Rules                                                         |
| ----------------- | --------- | ------------------------------------------------------------- | -------- | -------- | ---------------------------------------------------- |
| userId            | ref users | unique, role must be vendor                                   |
| shopName          | String    | 3-60, required                                                |
| shopSlug          | String    | unique, lowercase kebab                                       |
| description       | String    | ≤ 1000                                                        |
| logoKey           | String    | S3 key under own prefix                                       |
| status            | String    | `pending                                                      | approved | rejected | suspended`, default `pending`                        |
| commissionRateBps | Number    | nullable override, int 0-5000                                 |
| payoutAccount     | embedded  | `{ provider:'razorpay', linkedAccountId?, status:'not_created | pending  | active   | failed', bankLast4? }` (no full bank numbers stored) |

Indexes: `{userId:1}` unique; `{shopSlug:1}` unique; `{status:1}`.

## categories

`name`, `slug` (unique), `parentId?` (max depth 2), `defaultCommissionBps?` (0-5000), `isActive`, `sortOrder`.
Indexes: `{slug:1}` unique; `{parentId:1,sortOrder:1}`.

## products

| Field               | Type               | Rules                                                  |
| ------------------- | ------------------ | ------------------------------------------------------ | ------ | -------- | ---------- |
| vendorId            | ref vendors        | required                                               |
| title               | String             | 3-150                                                  |
| slug                | String             | unique (title + short id)                              |
| description         | String             | ≤ 5000                                                 |
| categoryId          | ref categories     | required, must be leaf-or-any active                   |
| pricePaise          | Number             | int ≥ 100                                              |
| compareAtPricePaise | Number             | optional, > pricePaise                                 |
| sku                 | String             | unique per vendor                                      |
| stockQty            | Number             | int ≥ 0                                                |
| images[]            | `{ key, alt? }`    | 1-6 items, keys must start with `products/{vendorId}/` |
| attributes          | Map<String,String> | ≤ 10 entries                                           |
| status              | String             | `draft                                                 | active | archived | suspended` |
| ratingAvg           | Number             | 0-5, default 0                                         |
| ratingCount         | Number             | int ≥ 0                                                |
| soldCount           | Number             | int ≥ 0                                                |

Indexes: `{slug:1}` unique; `{vendorId:1,sku:1}` unique; `{vendorId:1,status:1,createdAt:-1}`; `{categoryId:1,status:1,pricePaise:1}`; text index `{title:'text',description:'text'}` (search fallback).
Rule: a product is publicly visible only if `status='active'` and its vendor is `approved`.

## carts

`customerId` (unique), `items[]: { productId, quantity (1-10), addedAt }`, `couponCode?`. No prices stored. Indexes: `{customerId:1}` unique. Max 30 items.

## orders

| Field                                                   | Type              | Rules                                                        |
| ------------------------------------------------------- | ----------------- | ------------------------------------------------------------ | ----------------------------------- | ---------------------------- | --------- | -------- |
| orderNumber                                             | String            | unique `MP-YYYYMMDD-NNNNNN` (from `counters`)                |
| customerId                                              | ref users         |                                                              |
| status                                                  | String            | `pending_payment                                             | placed                              | completed                    | cancelled | expired` |
| paymentStatus                                           | String            | `unpaid                                                      | paid                                | failed`                      |
| refundStatus                                            | String            | `none                                                        | partial                             | full` (aggregate of refunds) |
| currency                                                | String            | `INR`                                                        |
| shippingAddress                                         | embedded snapshot | copy of address at checkout                                  |
| subtotalPaise, discountPaise, shippingPaise, totalPaise | Number            | `total = subtotal - discount + shipping` (shipping 0 in MVP) |
| coupon                                                  | embedded          | `{ couponId, code, fundedBy:'vendor                          | platform', discountPaise }` or null |
| reservationExpiresAt                                    | Date              | set while `pending_payment`                                  |
| idempotencyKey                                          | String            | unique per customer                                          |
| paymentId                                               | ref payments      |                                                              |
| placedAt                                                | Date              | set by markOrderPaid                                         |

Indexes: `{orderNumber:1}` unique; `{customerId:1,createdAt:-1}`; `{customerId:1,idempotencyKey:1}` unique; `{status:1,reservationExpiresAt:1}` (partial: status=pending_payment); `{createdAt:-1}`.

## subOrders

| Field                           | Type                              | Rules                                                                                                           |
| ------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------- | --------- | ---------- |
| subOrderNumber                  | String                            | `orderNumber-V{n}`                                                                                              |
| orderId, customerId, vendorId   | refs                              |                                                                                                                 |
| items[]                         | embedded snapshot                 | `{ productId, title, sku, imageKey, unitPricePaise, quantity, lineSubtotalPaise, discountPaise, lineNetPaise }` |
| subtotalPaise                   | Number                            | sum of `lineSubtotalPaise`                                                                                      |
| discountPaise                   | Number                            | allocated coupon discount                                                                                       |
| shippingPaise                   | Number                            | 0 in MVP                                                                                                        |
| customerTotalPaise              | Number                            | what the customer pays for this slice (`subtotal - discount + shipping`)                                        |
| commission                      | embedded                          | `{ rateBps, rateSource:'vendor                                                                                  | category   | platform', amountPaise, basePaise }` snapshot |
| vendorPayoutPaise               | Number                            | payout before refund adjustments                                                                                |
| fulfillmentStatus               | String                            | `pending_payment                                                                                                | processing | shipped                                       | delivered | cancelled` |
| refundStatus                    | String                            | `none                                                                                                           | pending    | partial                                       | full      | failed`    |
| refundedPaise                   | Number                            | cumulative processed refunds                                                                                    |
| stockRestored                   | Boolean                           | guard against double restock                                                                                    |
| tracking                        | embedded                          | `{ carrier?, trackingNumber? }`                                                                                 |
| statusHistory[]                 | `{ status, at, byUserId, note? }` | append-only                                                                                                     |
| deliveredAt, returnWindowEndsAt | Date                              |                                                                                                                 |

Indexes: `{orderId:1}`; `{vendorId:1,fulfillmentStatus:1,createdAt:-1}`; `{customerId:1,createdAt:-1}`; `{subOrderNumber:1}` unique; `{returnWindowEndsAt:1}` (partial: delivered).
Invariant: `sum(subOrders.customerTotalPaise) == order.totalPaise`.

## payments

`orderId`, `provider:'razorpay'`, `providerOrderId` (unique), `providerPaymentId` (unique, sparse), `amountPaise`, `currency`, `status: created|authorized|captured|failed`, `method?`, `failureReason?`, `capturedAt?`, `confirmedVia?: client_verify|webhook|reconcile`.
Indexes: `{providerOrderId:1}` unique; `{providerPaymentId:1}` unique sparse; `{orderId:1}`.

## refunds

`paymentId`, `orderId`, `subOrderId`, `amountPaise`, `commissionReversedPaise`, `vendorDebitPaise`, `reason` (enum `customer_cancel|admin|failed_late_capture`), `note?`, `status: initiated|processed|failed`, `providerRefundId` (unique sparse), `requestedBy`, `idempotencyKey` (unique).
Indexes: `{subOrderId:1}`; `{providerRefundId:1}` unique sparse; `{idempotencyKey:1}` unique.
Rule: `sum(refunds.amountPaise where status in initiated|processed) <= subOrder.customerTotalPaise`.

## settlements

`subOrderId` (unique), `orderId`, `vendorId`, `grossPaise` (vendor base before commission), `commissionPaise`, `refundAdjustmentPaise`, `netPayoutPaise`, `status: not_eligible|pending_release|released|settled|reversed|failed`, `providerTransferId?`, `eligibleAt?`, `releasedAt?`, `settledAt?`, `failureReason?`.
Indexes: `{subOrderId:1}` unique; `{vendorId:1,status:1,createdAt:-1}`; `{status:1,eligibleAt:1}`.
Rule: `netPayoutPaise = grossPaise - commissionPaise - refundAdjustmentPaise`, floor 0.

## coupons

| Field                               | Rules                                                     |
| ----------------------------------- | --------------------------------------------------------- | --------- |
| code                                | unique, uppercase `[A-Z0-9_-]{4,20}`                      |
| scope                               | `platform` or `vendor`; vendor coupons require `vendorId` |
| fundedBy                            | `platform` for platform scope; `vendor` for vendor scope  |
| type, value                         | `percent` (1-90) or `fixed` (paise ≥ 100)                 |
| minOrderPaise, maxDiscountPaise?    | ints                                                      |
| startsAt, expiresAt                 | expiresAt > startsAt                                      |
| usageLimitTotal?, usageLimitPerUser | ints ≥ 1                                                  |
| usedCount                           | int, maintained atomically                                |
| status                              | `active                                                   | disabled` |

Indexes: `{code:1}` unique; `{vendorId:1}`.

## couponRedemptions

`couponId`, `customerId`, `orderId`, `discountPaise`, `status: reserved|redeemed|released`. Indexes: `{couponId:1,orderId:1}` unique; `{couponId:1,customerId:1,status:1}`.

## reviews

`productId`, `vendorId`, `customerId`, `subOrderId`, `rating` (int 1-5), `title?` (≤100), `body` (10-2000), `status: published|hidden`. Indexes: `{customerId:1,productId:1}` unique; `{productId:1,status:1,createdAt:-1}`.

## invoices

`orderId` (unique), `invoiceNumber` (unique, `INV-YYYY-NNNNNN` from counters), `generatedAt`. PDF is generated on demand from order data (not stored).

## Supporting collections

- `counters`: `{ _id:'orderNumber:YYYYMMDD' | 'invoice:YYYY', seq }` via `$inc` upsert.
- `webhookEvents`: `provider, eventId (unique with provider), eventType, status: received|processed|failed|ignored, attempts, receivedAt, processedAt?, error?`; TTL 90 days on `receivedAt`.
- `searchOutbox`: `productId, op:'upsert|delete', attempts, nextAttemptAt, lastError?, createdAt`; index `{nextAttemptAt:1}`.
- `auditLogs`: `actorId, actorRole, action, entityType, entityId, meta, createdAt`; index `{entityType:1,entityId:1,createdAt:-1}`.
- `reconciliationReports`: `runAt, totals{...}, mismatches[], status`.
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
