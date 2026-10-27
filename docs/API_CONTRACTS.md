# API_CONTRACTS.md

Base URL: `/api/v1`. JSON only (webhook uses raw body). Auth: `Authorization: Bearer <accessToken>` unless "Public". Roles: C=customer, V=vendor (approved unless noted), A=admin.

## 1. Conventions

**Success:** `{ "success": true, "data": {...}, "meta": {...}? }`
**Error:** `{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "details": [{ "path": "body.email", "message": "Invalid email" }], "requestId": "req_8c1f" } }`
**Pagination:** `?page=1&limit=20` (limit ≤ 100) → `"meta": { "page": 1, "limit": 20, "total": 134, "totalPages": 7 }`. Sort: `?sort=-createdAt`.
**Headers:** `Idempotency-Key` (required on `POST /checkout`, optional on refunds), `X-Request-Id` returned on every response.

| HTTP | code                                                                      | When                                          |
| ---- | ------------------------------------------------------------------------- | --------------------------------------------- |
| 400  | `BAD_REQUEST`, `PAYMENT_VERIFICATION_FAILED`, `INVALID_WEBHOOK_SIGNATURE` | malformed / failed signature                  |
| 401  | `UNAUTHENTICATED`, `TOKEN_EXPIRED`                                        | no/invalid token                              |
| 403  | `FORBIDDEN`, `VENDOR_NOT_APPROVED`, `ACCOUNT_SUSPENDED`                   | role/status                                   |
| 404  | `NOT_FOUND`                                                               | missing or not owned                          |
| 409  | `CONFLICT`, `OUT_OF_STOCK`, `INVALID_STATE_TRANSITION`, `REVIEW_EXISTS`   | state conflicts                               |
| 422  | `VALIDATION_ERROR`, `COUPON_INVALID`                                      | semantic validation                           |
| 429  | `RATE_LIMITED`                                                            | with `Retry-After`                            |
| 502  | `PAYMENT_PROVIDER_ERROR`                                                  | provider failure                              |
| 500  | `INTERNAL_ERROR`                                                          | unexpected                                    |
| 503  | `SERVICE_UNAVAILABLE`                                                     | service or dependency temporarily unavailable |

## 2. Endpoint inventory

### Auth

| Method | Path                  | Auth   | Notes                                                |
| ------ | --------------------- | ------ | ---------------------------------------------------- |
| POST   | /auth/register        | Public | creates customer                                     |
| POST   | /auth/register-vendor | Public | creates user role=vendor (shop profile created next) |
| POST   | /auth/login           | Public | returns access token, sets refresh cookie            |
| POST   | /auth/refresh         | Cookie | rotates refresh token                                |
| POST   | /auth/logout          | Cookie | revokes family                                       |
| GET    | /auth/me              | Any    |                                                      |
| POST   | /auth/change-password | Any    | revokes other sessions                               |

### Users

| GET/PATCH    | /users/me                      | Any | name, phone |
| ------------ | ------------------------------ | --- | ----------- |
| GET/POST     | /users/me/addresses            | C   |             |
| PATCH/DELETE | /users/me/addresses/:addressId | C   |             |

### Public catalog and shops

| Method | Path | Auth | Notes |
| ------ | ---------------------------- | ------ | ----------------------------------------------------------------------------------------------------- | ----- | ------ | ---------- | ------------------------- |
| GET | /categories | Public | cached tree |
| GET | /products/search | Public | ES; params `q, categoryId, vendor (shopSlug), minPrice, maxPrice, minRating, inStock, sort (relevance | price | -price | -createdAt | -ratingAvg), page, limit` |
| GET | /products/:slug | Public | cached |
| GET | /shops/:shopSlug | Public | approved shops only |
| GET | /products/:productId/reviews | Public | published only, paginated |

### Cart and coupons

| GET    | /cart                  | C   | priced preview with current stock warnings              |
| ------ | ---------------------- | --- | ------------------------------------------------------- |
| PUT    | /cart/items/:productId | C   | body `{ quantity }` (0 removes)                         |
| DELETE | /cart/items/:productId | C   |                                                         |
| DELETE | /cart                  | C   |                                                         |
| POST   | /cart/coupon           | C   | body `{ code }`, validates and returns discount preview |
| DELETE | /cart/coupon           | C   |                                                         |

### Checkout, orders, payments

| POST | /checkout                                      | C                  | `Idempotency-Key`; returns provider order details        |
| ---- | ---------------------------------------------- | ------------------ | -------------------------------------------------------- |
| POST | /payments/verify                               | C                  | client-callback verification (server re-fetches payment) |
| POST | /webhooks/razorpay                             | Public (signature) | raw body                                                 |
| GET  | /orders                                        | C                  | paginated                                                |
| GET  | /orders/:orderId                               | C                  | includes subOrders                                       |
| POST | /orders/:orderId/sub-orders/:subOrderId/cancel | C                  | only before `shipped`                                    |
| GET  | /orders/:orderId/invoice                       | C                  | `application/pdf`, only if `paymentStatus=paid`          |

### Reviews

| POST         | /products/:productId/reviews | C         | delivered purchase required |
| ------------ | ---------------------------- | --------- | --------------------------- |
| PATCH/DELETE | /reviews/:reviewId           | C (owner) | edit/delete within 30 days  |

### Vendor console (`V`)

| GET/PATCH      | /vendor/profile                       | V (pending allowed) | shop profile                       |
| -------------- | ------------------------------------- | ------------------- | ---------------------------------- |
| POST           | /vendor/profile                       | role vendor         | create shop (once)                 |
| POST           | /vendor/payout-account                | V                   | creates provider linked account    |
| GET            | /vendor/payout-account                | V                   |                                    |
| GET/POST       | /vendor/products                      | V                   | list own / create                  |
| GET/PATCH      | /vendor/products/:productId           | V                   |                                    |
| DELETE         | /vendor/products/:productId           | V                   | archives                           |
| PATCH          | /vendor/products/:productId/stock     | V                   | `{ stockQty }`                     |
| POST           | /vendor/uploads/presign               | V                   |                                    |
| GET            | /vendor/sub-orders                    | V                   | filter `fulfillmentStatus`         |
| GET            | /vendor/sub-orders/:subOrderId        | V                   |                                    |
| PATCH          | /vendor/sub-orders/:subOrderId/status | V                   | transitions below                  |
| GET            | /vendor/settlements                   | V                   |                                    |
| GET            | /vendor/dashboard                     | V                   | sales, orders by status, low stock |
| GET/POST/PATCH | /vendor/coupons(/:couponId)           | V                   | vendor-scope coupons               |

### Admin (`A`)

| GET            | /admin/vendors                                                            | filter by status                                    |
| -------------- | ------------------------------------------------------------------------- | --------------------------------------------------- |
| PATCH          | /admin/vendors/:vendorId/status                                           | approve / reject / suspend                          |
| PATCH          | /admin/vendors/:vendorId/commission                                       | `{ commissionRateBps }`                             |
| GET / PATCH    | /admin/users, /admin/users/:userId/status                                 | suspend/reactivate                                  |
| GET/POST/PATCH | /admin/categories(/:categoryId)                                           |                                                     |
| PATCH          | /admin/products/:productId/status                                         | suspend/restore                                     |
| PATCH          | /admin/reviews/:reviewId/status                                           | hide/publish                                        |
| GET/POST/PATCH | /admin/coupons(/:couponId)                                                | platform coupons                                    |
| GET            | /admin/orders, /admin/orders/:orderId                                     |                                                     |
| POST           | /admin/sub-orders/:subOrderId/refund                                      | `{ amountPaise?, reason, note }`, `Idempotency-Key` |
| GET            | /admin/settlements                                                        | filter status/vendor                                |
| POST           | /admin/settlements/:settlementId/release                                  | manual release (demo/test)                          |
| GET / POST     | /admin/reconciliation, /admin/reconciliation/run                          |                                                     |
| GET            | /admin/analytics/overview, /sales-timeseries, /top-vendors, /top-products | cached 5 min                                        |
| POST           | /admin/search/reindex                                                     |                                                     |
| GET            | /health, /api/v1/health                                                   | Public                                              |
| GET            | /health/ready, /api/v1/health/ready                                       | Public                                              |

## 3. Sub-order transition table

`pending_payment → processing` (system only) · `processing → shipped` (V; body `{carrier, trackingNumber}`) · `shipped → delivered` (V) · `processing → cancelled` (V or C) · anything else → 409 `INVALID_STATE_TRANSITION`.

## 4. Examples

### POST /auth/register

Request: `{ "name": "Asha K", "email": "asha@example.com", "password": "S3cure!pass99" }`
Response 201: `{ "success": true, "data": { "user": { "id": "66f0...a1", "name": "Asha K", "email": "asha@example.com", "role": "customer" }, "accessToken": "eyJ..." } }`
Password rule: 10-72 chars, at least one letter and one digit.

### POST /vendor/products

Request:

```json
{
  "title": "Handloom Cotton Kurta",
  "description": "Soft handloom cotton...",
  "categoryId": "66ef...d4",
  "pricePaise": 149900,
  "sku": "KRT-001",
  "stockQty": 25,
  "images": [{ "key": "products/66f0...c3/9f2a.webp", "alt": "Front view" }],
  "status": "active"
}
```

Response 201: `{ "success": true, "data": { "id": "66f1...b2", "slug": "handloom-cotton-kurta-x7k2", "status": "active", ... } }`
Error 403 `VENDOR_NOT_APPROVED` if the shop isn't approved and status is `active`.

### GET /products/search?q=kurta&minPrice=50000&sort=price&page=1&limit=2

```json
{
  "success": true,
  "data": [
    {
      "id": "66f1...b2",
      "slug": "handloom-cotton-kurta-x7k2",
      "title": "Handloom Cotton Kurta",
      "pricePaise": 149900,
      "imageUrl": "https://.../products/66f0...c3/9f2a.webp",
      "ratingAvg": 4.6,
      "ratingCount": 12,
      "shop": { "name": "Loom & Co", "slug": "loom-co" },
      "inStock": true
    }
  ],
  "meta": { "page": 1, "limit": 2, "total": 37, "totalPages": 19 }
}
```

### POST /checkout

Headers: `Idempotency-Key: 7d0f...`. Request: `{ "addressId": "66f0...aa", "couponCode": "WELCOME10" }`
Response 201:

```json
{
  "success": true,
  "data": {
    "order": {
      "id": "66f2...e5",
      "orderNumber": "MP-20261025-000123",
      "status": "pending_payment",
      "subtotalPaise": 299800,
      "discountPaise": 29980,
      "shippingPaise": 0,
      "totalPaise": 269820,
      "reservationExpiresAt": "2026-10-25T10:15:00Z"
    },
    "payment": {
      "provider": "razorpay",
      "providerOrderId": "order_TEST789",
      "keyId": "rzp_test_xxx",
      "amountPaise": 269820,
      "currency": "INR"
    }
  }
}
```

Errors: 409 `OUT_OF_STOCK` `{ "details": [{ "productId": "66f1...b2", "available": 1 }] }`; 422 `COUPON_INVALID` `{ "details": { "reason": "expired" } }`; 502 `PAYMENT_PROVIDER_ERROR`.

### POST /payments/verify

Request: `{ "orderId": "66f2...e5", "razorpayOrderId": "order_TEST789", "razorpayPaymentId": "pay_TEST111", "razorpaySignature": "..." }`
Response 200: `{ "success": true, "data": { "orderId": "66f2...e5", "status": "placed", "paymentStatus": "paid" } }` (also returned, unchanged, if the webhook already processed it). 400 `PAYMENT_VERIFICATION_FAILED` on bad signature or provider/amount mismatch.

### POST /webhooks/razorpay

Always 200 for valid signature (including duplicates and ignored events); 400 `INVALID_WEBHOOK_SIGNATURE` otherwise. Body per provider (verify V3).

### PATCH /vendor/sub-orders/:id/status

Request: `{ "status": "shipped", "tracking": { "carrier": "DTDC", "trackingNumber": "D123456" } }`
Response 200: updated sub-order. 409 `INVALID_STATE_TRANSITION` for e.g. `delivered → processing`.

### POST /admin/sub-orders/:id/refund

Request: `{ "amountPaise": 100000, "reason": "admin", "note": "Damaged item" }` →
`{ "success": true, "data": { "refund": { "id": "...", "status": "initiated", "amountPaise": 100000, "commissionReversedPaise": 10000, "vendorDebitPaise": 90000 } } }`

### POST /products/:productId/reviews

Request: `{ "rating": 5, "title": "Great fit", "body": "Fabric is lovely and true to size." }` → 201 review.
Errors: 403 `FORBIDDEN` (no delivered purchase), 409 `REVIEW_EXISTS`.

### GET /health/ready

Public. Returns HTTP 200 when the service is ready to accept requests,
or HTTP 503 when it is not ready.

Success response (200):

{
"success": true,
"data": {
"status": "ready"
}
}

Unavailable response (503):

{
"success": false,
"error": {
"code": "SERVICE_UNAVAILABLE",
"message": "Service is not ready"
}
}
