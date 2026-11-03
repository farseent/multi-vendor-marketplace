# API_CONTRACTS.md

Base URL: `/api/v1`. JSON only (webhook uses raw body). Auth: `Authorization: Bearer <accessToken>` unless "Public". Roles: C=customer, V=vendor (approved unless noted), A=admin.

## 1. Conventions

**Success:** `{ "success": true, "data": {...}, "meta": {...}? }`
**Error:** `{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "details": [{ "path": "body.email", "message": "Invalid email" }], "requestId": "req_8c1f" } }`
**Pagination:** `?page=1&limit=20` (limit ≤ 100) → `"meta": { "page": 1, "limit": 20, "total": 134, "totalPages": 7 }`. Sort: `?sort=-createdAt`.
**Headers:** `Idempotency-Key` (required on `POST /checkout`, optional on refunds), `X-Request-Id` returned on every response.

| HTTP | code                                                                      | When                                                      |
| ---- | ------------------------------------------------------------------------- | --------------------------------------------------------- |
| 400  | `BAD_REQUEST`, `PAYMENT_VERIFICATION_FAILED`, `INVALID_WEBHOOK_SIGNATURE` | malformed / failed signature                              |
| 401  | `UNAUTHENTICATED`, `TOKEN_EXPIRED`                                        | no/invalid token                                          |
| 403  | `FORBIDDEN`, `VENDOR_NOT_APPROVED`, `ACCOUNT_SUSPENDED`                   | role/status                                               |
| 404  | `NOT_FOUND`                                                               | missing or not owned                                      |
| 409  | `CONFLICT`, `OUT_OF_STOCK`, `INVALID_STATE_TRANSITION`, `REVIEW_EXISTS`   | state conflicts, including more than 5 customer addresses |
| 422  | `VALIDATION_ERROR`, `COUPON_INVALID`                                      | semantic validation                                       |
| 429  | `RATE_LIMITED`                                                            | with `Retry-After`                                        |
| 502  | `PAYMENT_PROVIDER_ERROR`                                                  | provider failure                                          |
| 500  | `INTERNAL_ERROR`                                                          | unexpected                                                |
| 503  | `SERVICE_UNAVAILABLE`                                                     | service or dependency temporarily unavailable             |

## 2. Endpoint inventory

### Auth

| Method | Path                  | Auth   | Notes                                                                                                    |
| ------ | --------------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| POST   | /auth/register        | Public | creates customer                                                                                         |
| POST   | /auth/register-vendor | Public | creates user role=vendor (shop profile created next)                                                     |
| POST   | /auth/login           | Public | returns access token, sets refresh cookie                                                                |
| POST   | /auth/refresh         | Cookie | rotates refresh token; returns `{ user, accessToken }`                                                   |
| POST   | /auth/logout          | Cookie | idempotent; revokes family; returns `{ loggedOut: true }`                                                |
| GET    | /auth/me              | Any    |                                                                                                          |
| POST   | /auth/change-password | Any    | wrong `currentPassword` returns 422 `VALIDATION_ERROR` at `body.currentPassword`; revokes other sessions |

### Users

| GET/PATCH    | /users/me                      | Any               | name, phone                                        |
| ------------ | ------------------------------ | ----------------- | -------------------------------------------------- |
| GET/POST     | /users/me/addresses            | C (customer-only) | maximum 5 addresses; POST returns 409 at the limit |
| PATCH/DELETE | /users/me/addresses/:addressId | C (customer-only) | customer-owned addresses only                      |

### Public catalog and shops

| Method | Path                         | Auth   | Notes                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | ---------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | /categories                  | Public | cached tree                                                                                                                                                                                                                                                                                                                                                                      |
| GET    | /products/search             | Public | ES; params `q, categoryId, vendor (shopSlug), minPrice, maxPrice, minRating, inStock, sort (relevance, price, -price, -createdAt, -ratingAvg), page, limit`; `minPrice` and `maxPrice` are integer paise; `page * limit` must be ≤ 10000 (otherwise 422); returns `X-Search-Fallback: mongo` when served by Mongo fallback; rate limit 60 requests/minute/IP (429 when exceeded) |
| GET    | /products/:slug              | Public | cached                                                                                                                                                                                                                                                                                                                                                                           |
| GET    | /shops/:shopSlug             | Public | approved shops only                                                                                                                                                                                                                                                                                                                                                              |
| GET    | /products/:productId/reviews | Public | published only, paginated                                                                                                                                                                                                                                                                                                                                                        |

### Cart and coupons

| GET    | /cart                  | C   | priced preview with current stock warnings              |
| ------ | ---------------------- | --- | ------------------------------------------------------- |
| PUT    | /cart/items/:productId | C   | body `{ quantity }` (0 removes)                         |
| DELETE | /cart/items/:productId | C   |                                                         |
| DELETE | /cart                  | C   |                                                         |
| POST   | /cart/coupon           | C   | body `{ code }`, validates and returns discount preview |
| DELETE | /cart/coupon           | C   |                                                         |

#### Cart and coupon details (Phase 4)

Every cart endpoint (`GET/DELETE /cart`, `PUT/DELETE /cart/items/:productId`, `POST/DELETE /cart/coupon`) returns the whole priced cart. Customers only (vendor/admin tokens: 403).

```json
{
  "items": [
    {
      "productId": "66f1...b2",
      "slug": "handloom-cotton-kurta-x7k2",
      "title": "Handloom Cotton Kurta",
      "imageUrl": "https://cdn.example/products/...webp",
      "shop": { "name": "Loom & Co", "slug": "loom-co" },
      "quantity": 2,
      "status": "ok",
      "unitPricePaise": 149900,
      "lineSubtotalPaise": 299800,
      "discountPaise": 29980,
      "lineNetPaise": 269820
    }
  ],
  "itemCount": 2,
  "currency": "INR",
  "subtotalPaise": 299800,
  "discountPaise": 29980,
  "shippingPaise": 0,
  "totalPaise": 269820,
  "coupon": { "code": "WELCOME10", "scope": "platform", "type": "percent", "discountPaise": 29980 },
  "couponError": null,
  "hasIssues": false
}
```

- Line `status`: `ok`, `insufficient_stock` (adds `available`; still priced, counted in totals), or `unavailable` (product not active or shop not approved; only `productId`, `quantity`, `status`, `title`; not priced, not counted).
- `couponError: { code, reason }` (with `coupon: null` and no discount) when the saved coupon is no longer valid.
- `PUT /cart/items/:productId` body `{ quantity }` (integer 0-10; 0 removes): 422 above 10 or non-integer; 409 `CONFLICT` if the product cannot be bought (including a non-existent id) or the cart already has 30 distinct products; 409 `OUT_OF_STOCK` with `details: [{ productId, available }]` if quantity exceeds stock.
- `POST /cart/coupon` body `{ code }` (case-insensitive): 422 `COUPON_INVALID` with `details: { reason }`, where reason is one of `not_found, disabled, not_started, expired, empty_cart, wrong_vendor, below_min_order, total_limit_reached, user_limit_reached`. A refused code leaves the cart's existing coupon unchanged.
- `DELETE` endpoints are idempotent.

#### Coupons (Phase 4)

`GET/POST /vendor/coupons`, `GET/PATCH /vendor/coupons/:couponId` (approved shop; own coupons; other vendors' ids: 404) and `GET/POST /admin/coupons`, `GET/PATCH /admin/coupons/:couponId` (platform coupons only). List: `?status=active|disabled&page&limit`.
Create body: `{ code, type: "percent"|"fixed", value, minOrderPaise?=0, maxDiscountPaise? (percent only), startsAt, expiresAt (ISO-8601 with timezone), usageLimitTotal?, usageLimitPerUser?=1, status?="active" }`. `scope`, `fundedBy` and `vendorId` are set by the server. 422 field errors use `body.<field>` paths; duplicate code: 409 `CONFLICT`.
Update body (at least one of): `value, minOrderPaise, maxDiscountPaise (null clears), startsAt, expiresAt, usageLimitTotal (null clears), usageLimitPerUser, status`. `code`, `type` and `usedCount` cannot be changed.

### Checkout, orders, payments

| POST | /checkout                                      | C                  | `Idempotency-Key`; returns provider order details        |
| ---- | ---------------------------------------------- | ------------------ | -------------------------------------------------------- |
| POST | /payments/verify                               | C                  | client-callback verification (server re-fetches payment) |
| POST | /payments/mock/complete                        | C                  | development only (MockLedger, not production), see below |
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

| GET | /vendor/profile | V (pending allowed) | 404 `NOT_FOUND` until the shop profile exists |
| POST | /vendor/profile | role vendor | create shop (once); body `{ shopName, description? }` |
| PATCH | /vendor/profile | V (pending allowed) | body `{ shopName?, description?, logoKey? }`; `description: null` and `logoKey: null` clear those fields |
| POST | /vendor/payout-account | V | **Deferred: not implemented in Phase 5 (D49).** Linked accounts are created in the Razorpay Dashboard and attached by an admin-only script |
| GET | /vendor/payout-account | V | **Deferred: not implemented in Phase 5 (D49)** |
| GET/POST | /vendor/products | V | list own / create; POST `status` is `draft` (default) or `active` |
| GET/PATCH | /vendor/products/:productId | V | PATCH does not accept `stockQty`; use `/stock` |
| DELETE | /vendor/products/:productId | V | archives |
| PATCH | /vendor/products/:productId/stock | V | `{ stockQty }` |
| POST | /vendor/uploads/presign | V | body `{ contentType, sizeBytes }`; see upload contract below |
| GET | /vendor/sub-orders | V | filter `fulfillmentStatus` |
| GET | /vendor/sub-orders/:subOrderId | V | |
| PATCH | /vendor/sub-orders/:subOrderId/status | V | transitions below |
| GET | /vendor/settlements | V | |
| GET | /vendor/dashboard | V | sales, orders by status, low stock |
| GET/POST/PATCH | /vendor/coupons(/:couponId) | V | vendor-scope coupons |

### Admin (`A`)

| GET            | /admin/vendors                                                            | filter by status                                                                   |
| -------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| PATCH          | /admin/vendors/:vendorId/status                                           | body `{ status }`; approve / reject / suspend; see vendor status transitions below |
| PATCH          | /admin/vendors/:vendorId/commission                                       | `{ commissionRateBps }`; accepts `null`                                            |
| GET / PATCH    | /admin/users, /admin/users/:userId/status                                 | suspend/reactivate                                                                 |
| GET/POST/PATCH | /admin/categories(/:categoryId)                                           |                                                                                    |
| PATCH          | /admin/products/:productId/status                                         | suspend/restore                                                                    |
| PATCH          | /admin/reviews/:reviewId/status                                           | hide/publish                                                                       |
| GET/POST/PATCH | /admin/coupons(/:couponId)                                                | platform coupons                                                                   |
| GET            | /admin/orders, /admin/orders/:orderId                                     |                                                                                    |
| POST           | /admin/sub-orders/:subOrderId/refund                                      | `{ amountPaise?, reason, note }`, `Idempotency-Key`                                |
| GET            | /admin/settlements                                                        | filter status/vendor                                                               |
| POST           | /admin/settlements/:settlementId/release                                  | manual release (demo/test)                                                         |
| GET / POST     | /admin/reconciliation, /admin/reconciliation/run                          |                                                                                    |
| GET            | /admin/analytics/overview, /sales-timeseries, /top-vendors, /top-products | cached 5 min                                                                       |
| POST           | /admin/search/reindex                                                     | A                                                                                  | Rebuilds Elasticsearch index; 200 `{ index, indexed, durationMs }`; 409 if a sync/reindex holds the lease; 503 if search is not configured or rebuild fails |
| GET            | /health, /api/v1/health                                                   | Public                                                                             |
| GET            | /health/ready, /api/v1/health/ready                                       | Public                                                                             |

## 3. Sub-order transition table

`pending_payment → processing` (system only) · `processing → shipped` (V; body `{carrier, trackingNumber}`) · `shipped → delivered` (V) · `processing → cancelled` (V or C) · anything else → 409 `INVALID_STATE_TRANSITION`.

### Vendor profile

- `POST /vendor/profile` creates the vendor's shop profile. Request body: `{ "shopName": "Loom & Co", "description": "Handwoven essentials" }`. `description` is optional.
- `PATCH /vendor/profile` updates the profile. Request body: `{ "shopName": "Loom & Co", "description": "Handwoven essentials", "logoKey": "shops/66f0...c3/logo.webp" }`. All fields are optional; `description: null` clears the description and `logoKey: null` clears the logo.
- `GET /vendor/profile` returns 404 `NOT_FOUND` until the shop profile exists.

### Vendor uploads

`POST /vendor/uploads/presign` accepts:

```json
{
  "contentType": "image/jpeg",
  "sizeBytes": 1048576
}
```

`contentType` must be one of `image/jpeg`, `image/png`, or `image/webp`. `sizeBytes` must be an integer from 1 through 5242880 inclusive.

Response 201:

```json
{
  "uploadUrl": "https://storage.example/...",
  "method": "PUT",
  "headers": { "Content-Type": "image/jpeg" },
  "key": "uploads/66f0...c3/image.webp",
  "publicUrl": "https://cdn.example/uploads/66f0...c3/image.webp",
  "expiresInSeconds": 300
}
```

Returns 503 `SERVICE_UNAVAILABLE` when S3 is not configured.

### Public catalog response shapes

`GET /categories` returns a category tree:

```json
[
  {
    "id": "66ef...d4",
    "name": "Clothing",
    "slug": "clothing",
    "children": [{ "id": "66ef...d5", "name": "Kurtas", "slug": "kurtas" }]
  }
]
```

`GET /products/:slug` returns:

```json
{
  "id": "66f1...b2",
  "slug": "handloom-cotton-kurta-x7k2",
  "title": "Handloom Cotton Kurta",
  "description": "Soft handloom cotton...",
  "categoryId": "66ef...d4",
  "pricePaise": 149900,
  "compareAtPricePaise": 179900,
  "images": [{ "url": "https://cdn.example/products/kurta.webp", "alt": "Front view" }],
  "attributes": { "fabric": "cotton" },
  "ratingAvg": 4.6,
  "ratingCount": 12,
  "inStock": true,
  "shop": { "name": "Loom & Co", "slug": "loom-co" },
  "createdAt": "2026-10-25T10:00:00Z"
}
```

### Vendor product creation and updates

- `POST /vendor/products` accepts `status: "draft"` (the default when omitted) or `status: "active"`.
- `PATCH /vendor/products/:productId` does not accept `stockQty`. Update stock only through `PATCH /vendor/products/:productId/stock` with `{ "stockQty": 25 }`.

### Vendor shop prerequisite

Vendor routes that require a shop profile return HTTP 403 with error code `FORBIDDEN` when the vendor's shop profile does not exist yet. This shop-prerequisite response is distinct from `GET /vendor/profile`, which returns 404 until the profile exists.

### Vendor status transitions

`PATCH /admin/vendors/:vendorId/status` accepts `{ "status": "approved" | "rejected" | "suspended" }`.

| Current status | Allowed next status    |
| -------------- | ---------------------- |
| `pending`      | `approved`, `rejected` |
| `approved`     | `suspended`            |
| `suspended`    | `approved`             |
| `rejected`     | `approved`             |

Any transition not listed above returns 409 `INVALID_STATE_TRANSITION`.

## 4. Examples

### POST /auth/register

Request: `{ "name": "Asha K", "email": "asha@example.com", "password": "S3cure!pass99" }`
Response 201: `{ "success": true, "data": { "user": { "id": "66f0...a1", "name": "Asha K", "email": "asha@example.com", "role": "customer" }, "accessToken": "eyJ..." } }`
Password rule: 10-72 chars, at least one letter and one digit.

### POST /auth/refresh

Auth: refresh-token cookie.

Response 200:

```json
{
  "user": {
    "id": "66f0...a1",
    "name": "Asha K",
    "email": "asha@example.com",
    "role": "customer"
  },
  "accessToken": "eyJ..."
}
```

The refresh token is rotated and returned as an httpOnly cookie. Reuse or expiry returns 401.

### POST /auth/logout

Auth: refresh-token cookie.

Response 200:

```json
{
  "loggedOut": true
}
```

This endpoint is idempotent: repeating a logout request still returns a successful logged-out result.

### POST /auth/change-password

If `currentPassword` is incorrect, the endpoint returns HTTP 422 with a validation detail whose path is `body.currentPassword`.

Example detail:

```json
{
  "path": "body.currentPassword",
  "message": "Current password is incorrect"
}
```

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

### POST /admin/search/reindex

Auth: Admin (`A`).

Response 200:

```json
{
  "success": true,
  "data": {
    "index": "products-v2",
    "indexed": 1250,
    "durationMs": 3420
  }
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

Implemented rules (D47, D49, D50, D53). Every check runs before anything is written, in this order: 422 `VALIDATION_ERROR` with `details.reason` `empty_cart`; 409 `OUT_OF_STOCK` / 409 `CONFLICT` (`details.reason: unavailable`); 422 `COUPON_INVALID` for a coupon that no longer validates; 422 `VALIDATION_ERROR` with `details.reason` `zero_total` (total is 0) or `below_minimum_total` (total of 1-99 paise); 409 `CONFLICT` with `details.reason` `vendor_payout_unavailable` and `details.productIds` when a vendor in the cart has no active payout account; 422 `VALIDATION_ERROR` with `details.reason` `payout_below_minimum` (a sub-order payout under 100 paise, `details.productIds` lists its products); 422 `COUPON_INVALID` with `details.reason` `exceeds_platform_margin` (the vendor payouts would exceed what the customer pays). `exceeds_platform_margin` is returned by checkout only, never by `POST /cart/coupon` or the cart preview (a known gap).

Request details (D53): body `{ addressId, couponCode? }` is strict (unknown fields are 422). `couponCode` omitted uses the coupon saved in the cart; `null` means no coupon. The `Idempotency-Key` header is required (8-100 characters of `A-Z a-z 0-9 . _ : -`; 422 with `details[0].path = "headers.idempotency-key"` otherwise). The first call answers **201**; a repeat with the same key answers **200** with the same body; a key whose order expired or failed answers 409 `CONFLICT` (use a new key). 429 after 10 checkout requests per minute per customer. If the provider order cannot be created: 502 `PAYMENT_PROVIDER_ERROR`, the order is expired and the cart (and its saved coupon) is restored.

### GET /orders, GET /orders/:orderId

`GET /orders?page&limit` (customer, newest first, `meta` as everywhere): `[{ id, orderNumber, status, paymentStatus, refundStatus, currency, totalPaise, placedAt, createdAt }]`. `GET /orders/:orderId` adds `subtotalPaise, discountPaise, shippingPaise, shippingAddress, coupon { code, discountPaise } | null` and `subOrders: [{ id, subOrderNumber, shop { name, slug }, items[], subtotalPaise, discountPaise, shippingPaise, customerTotalPaise, fulfillmentStatus, refundStatus, refundedPaise, tracking, deliveredAt, returnWindowEndsAt }]`. While the order is `pending_payment` it also returns `reservationExpiresAt` and `payment { provider, providerOrderId, keyId, amountPaise, currency }` so the page can resume payment. Another customer's order, or an unknown id, is 404. Commission, vendor payout, stock flags and the idempotency key are never returned to customers.

### POST /payments/verify

Request: `{ "orderId": "66f2...e5", "razorpayOrderId": "order_TEST789", "razorpayPaymentId": "pay_TEST111", "razorpaySignature": "..." }`
Response 200: `{ "success": true, "data": { "orderId": "66f2...e5", "status": "placed", "paymentStatus": "paid", "refundStatus": "none" } }` (also returned, unchanged, if the webhook already processed it). If the payment arrived after the order expired and the stock was gone, the answer is 200 with `status: "expired", paymentStatus: "paid", refundStatus: "full"` (D54). 400 `PAYMENT_VERIFICATION_FAILED` on bad signature or provider/amount mismatch.

Rules (D48): the signature is checked against the order id **stored** on the server; a `razorpayOrderId` that differs from the stored one is a 400. If the provider reports the payment as `authorized` but not yet `captured`, the answer is 200 with `{ status: "pending_payment", paymentStatus: "unpaid" }` and the client polls `GET /orders/:orderId`; the webhook or the reconcile job completes the order.

### POST /webhooks/razorpay

Always 200 for valid signature (including duplicates and ignored events); 400 `INVALID_WEBHOOK_SIGNATURE` otherwise. Razorpay must receive the answer within 5 seconds.

Headers (verified, D46): `X-Razorpay-Signature` (HMAC of the raw body with the webhook secret) and `x-razorpay-event-id` (unique per event; the duplicate key). Body: `{ "entity": "event", "account_id": "acc_...", "event": "payment.captured", "contains": ["payment"], "payload": { "payment": { "entity": { "id": "pay_...", "order_id": "order_...", "amount": 269820, "currency": "INR", "status": "captured" } } } }` (abridged; the payment entity has more fields). `order.paid` carries both `payload.order` and `payload.payment`.

Phase 5 acts on `payment.captured`, `payment.failed` and `order.paid`. Every other event is stored as `ignored` and answered 200. Phase 6 acts on `refund.processed`, `refund.failed`, `transfer.processed` and `transfer.failed` (D59); `refund.created`, `refund.speed_changed` and `settlement.processed` are stored as `ignored`. Payment state is always confirmed by a provider fetch, never taken from the body. A processing failure (database or provider trouble, or an amount that does not match) is recorded on the `webhookEvents` row as `failed` and still answered 200; it is recovered by a redelivery of the same event (the row is re-claimed atomically, D46) or by the reconcile job, which asks the provider directly.

### POST /payments/mock/complete (development only, D55)

Request `{ "orderId" }` (the customer's own pending order). Response 200: `{ razorpayOrderId, razorpayPaymentId, razorpaySignature }`, i.e. what Razorpay Checkout would hand the browser; send it to `POST /payments/verify`. 404 when the provider is not the MockLedger or `NODE_ENV` is `production`.

### PATCH /vendor/sub-orders/:id/status (implemented, Phase 6, D58)

Request: `{ "status": "shipped", "tracking": { "carrier": "DTDC", "trackingNumber": "D123456" } }` (`tracking` is required for `shipped` and refused for any other status: 422). `{ "status": "delivered" }` and `{ "status": "cancelled" }` take no tracking.
Response 200: the vendor's view of the updated sub-order (see below). 404 for another vendor's sub-order or one that was never paid; 403 `VENDOR_NOT_APPROVED` unless the shop is approved; 409 `INVALID_STATE_TRANSITION` for any move not in the table (including `status: "processing"` and a second identical request). `cancelled` also refunds the sub-order in full (reason `vendor_cancel`).

**Vendor view of a sub-order** (`GET /vendor/sub-orders`, `GET /vendor/sub-orders/:id`; list is paginated, filter `fulfillmentStatus` = `processing|shipped|delivered|cancelled`): `{ id, subOrderNumber, orderNumber, items[{ productId, title, sku, unitPricePaise, quantity, lineNetPaise }], subtotalPaise, discountPaise, customerTotalPaise, commission{ rateBps, amountPaise }, vendorPayoutPaise, fulfillmentStatus, refundStatus, refundedPaise, tracking, shippingAddress, settlementStatus, deliveredAt, returnWindowEndsAt, createdAt }`. No customer id, email or account data; `pending_payment` and never-paid sub-orders are not listed.

### POST /orders/:orderId/sub-orders/:subOrderId/cancel (implemented, Phase 6)

Customer only, no body. Allowed only while the sub-order is `processing`; it is cancelled, the stock goes back once and the rest of the sub-order is refunded. Response 200: `{ "data": { "refundId": "..." | null, "order": <GET /orders/:id view> } }`. 404 for someone else's sub-order or a mismatched order id; 409 `INVALID_STATE_TRANSITION` once shipped or already cancelled. If the provider is unavailable the cancel still stands and the refund completes later (the sub-order shows `refundStatus: "pending"`).

### POST /admin/sub-orders/:id/refund (implemented, Phase 6, D57)

Request: `{ "amountPaise": 100000, "reason": "admin", "note": "Damaged item" }`. `amountPaise` is optional (omitted = everything still refundable), an integer of at least 1; `reason` must be `admin`; `note` 3-300 characters; unknown fields are 422. The `Idempotency-Key` header is optional.
Response **201** (first call) or **200** (repeat of the same key):
`{ "success": true, "data": { "refund": { "id": "...", "status": "processed", "amountPaise": 100000, "commissionReversedPaise": 10000, "vendorDebitPaise": 90000 }, "subOrder": { "id": "...", "fulfillmentStatus": "processing", "refundStatus": "partial", "refundedPaise": 100000 } } }`. `refund.status` is `initiated` when the provider has not confirmed yet (it completes by webhook or by the reconcile job).
Errors: 404 unknown or never-paid sub-order; 409 `CONFLICT` with `details.reason` = `exceeds_refundable` (+ `refundablePaise`), `not_refundable` (cancelled or unpaid), `return_window_closed`, `idempotency_key_reused`; 422 `VALIDATION_ERROR` with `details.reason: "refund_below_minimum"` when the vendor's share is 1-99 paise (Razorpay reverses at least INR 1.00). A refund that takes an unshipped sub-order to zero also cancels it and puts the stock back.

### Settlements and reconciliation (implemented, Phase 6, D59, D60)

- `GET /vendor/settlements?status=&page=&limit=`: the vendor's own, newest first: `{ id, subOrderId, subOrderNumber, grossPaise, commissionPaise, refundAdjustmentPaise, netPayoutPaise, status, eligibleAt, releasedAt, settledAt, createdAt }`. Settlements of orders that were never paid are not listed. No provider ids.
- `GET /admin/settlements?status=&vendorId=&page=&limit=`: the same plus `vendorId`, `providerTransferId`, `failureReason`.
- `POST /admin/settlements/:settlementId/release` (no body): manual release, ignores the return window only. 200 `{ id, status: "released", releasedAt, netPayoutPaise }`; 409 `INVALID_STATE_TRANSITION` if not `pending_release`; 409 `CONFLICT` `details.reason` = `open_refund | nothing_to_release | payout_account_inactive | no_provider_transfer | changed_meanwhile`; 502 `PAYMENT_PROVIDER_ERROR` (the settlement stays `pending_release`); audited as `settlement.released`.
- `POST /admin/reconciliation/run` (no body): 201 with the report; 409 `CONFLICT` `details.reason: "run_in_progress"`; audited as `reconciliation.run`. `GET /admin/reconciliation?page=&limit=`: reports, newest first. Report: `{ id, runAt, status: "ok"|"mismatch", trigger, totals, mismatches[] }`.

### POST /products/:productId/reviews

Request: `{ "rating": 5, "title": "Great fit", "body": "Fabric is lovely and true to size." }` → 201 review.
Errors: 403 `FORBIDDEN` (no delivered purchase), 409 `REVIEW_EXISTS`.

### GET /health/ready

Public. Returns HTTP 200 when the service is ready to accept requests, or HTTP 503 when it is not ready.

**Response body:** The current `HANDOVER.md` documents these HTTP status codes but does not define a response JSON shape. Do not rely on the previous `{ "success": true, "data": { "status": "ready" } }` / `SERVICE_UNAVAILABLE` examples as the current contract. Update this section with the exact response bodies once confirmed from the implemented health route.
