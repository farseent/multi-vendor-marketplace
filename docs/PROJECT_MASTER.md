# PROJECT_MASTER.md

## 1. Purpose

A portfolio-quality, Amazon-style multi-vendor marketplace. Customers buy from many vendors in one checkout; vendors run their own shops; the platform earns a commission on each vendor's sales.

## 2. Scope

### In scope (MVP)

- Auth (JWT access + rotating refresh), RBAC for customer / vendor / admin
- Vendor onboarding with admin approval; payout account via payment provider (test mode)
- Product catalog, categories, S3 image upload, Elasticsearch search, Redis caching
- Cart, coupons, multi-vendor checkout, inventory reservation
- Payments (Razorpay Route, test mode), refunds, vendor settlements, commission
- Vendor fulfillment per sub-order; order tracking for customers
- Reviews, PDF invoices, admin moderation and analytics

### Out of scope (MVP)

Product variants, guest carts, shipping-carrier integration, multi-currency, multi-language, tax/GST compliance, email verification, social login, real-money payments, microservices, real-time notifications, vendor KYC document storage, returns logistics (refund is admin-triggered).

## 3. Roles

| Role     | Can                                                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer | Browse/search, cart, coupons, checkout, track orders, cancel unshipped sub-orders, download invoice, review delivered products                                                                                      |
| Vendor   | Manage own shop profile, products, stock, vendor coupons; view and fulfil own sub-orders; view own settlements and stats. Cannot see other vendors' data or customer data beyond shipping details of own sub-orders |
| Admin    | Approve/suspend vendors, set commission, moderate products/reviews, manage categories and platform coupons, issue refunds, view settlements/reconciliation and analytics                                            |

Single `role` field per user. Admin accounts are created only by a seed script.

## 4. Technology stack

| Layer                    | Choice                                                                        |
| ------------------------ | ----------------------------------------------------------------------------- |
| Frontend                 | React (Vite), React Router, TanStack Query                                    |
| Backend                  | Node.js >= 22.9.0, Express, ES modules                                        |
| DB                       | MongoDB (replica set, required for transactions) + Mongoose                   |
| Search                   | Elasticsearch (official JS client)                                            |
| Cache / rate limit store | Redis (ioredis)                                                               |
| Images                   | AWS S3 via presigned PUT URLs                                                 |
| Auth                     | JWT access token, rotating refresh token in httpOnly cookie, bcrypt (cost 12) |
| Payments                 | Razorpay Route, test mode, behind `PaymentProvider` interface                 |
| Validation               | Zod                                                                           |
| Logging                  | pino + request IDs                                                            |
| PDF                      | pdfkit                                                                        |
| Tests                    | Vitest/Jest, supertest, mongodb-memory-server (replica set), Playwright       |
| Deployment               | Frontend and backend deployed separately (hosts TBD, see V4/V5)               |

## 5. Repository layout (monorepo)

```
marketplace/
  client/                 # React app
  server/
    src/
      config/             # env parsing (Zod), constants, auth configuration
      modules/<name>/     # routes, controller, service, model, validator, (search|cache helpers)
      middleware/         # auth, rbac, validate, rateLimit, originCheck, error, requestId
      lib/                # db, redis, es, s3, logger, money, AppError
      providers/payment/  # PaymentProvider interface, razorpay, mockLedger
      jobs/               # reservationRelease, searchSync, settlementRelease, reconcile
      scripts/            # seed, reindex
    tests/
  docs/                   # the 7 planning docs
```

Modules: auth, users, shops, catalog (categories, products), uploads, search, cart, coupons, orders (checkout, orders, subOrders), payments, refunds, settlements, reviews, invoices, admin.

## 6. Conventions (single source of truth)

- **Naming:** collections plural camelCase (`subOrders`); fields camelCase; enum values lowercase snake_case; routes kebab-case plural nouns under `/api/v1`; vendor-console routes under `/api/v1/vendor/*`, admin under `/api/v1/admin/*`.
- **File naming:** Module files use the `<module>.<type>.js` convention, such as `auth.routes.js`, `auth.controller.js`, `auth.service.js`, `auth.model.js`, and `auth.validator.js`. Use the module name as the filename prefix and the component type as the suffix.
- **IDs:** Mongo ObjectId internally; API returns `id` (string). Human-readable `orderNumber`, `subOrderNumber`, `invoiceNumber`.
- **Money:** integer paise, fields end in `Paise`; currency always `"INR"` and stored on payment documents. Rates end in `Bps` (100 bps = 1%). Never floats.
- **Time:** UTC, ISO-8601 strings in API; `createdAt/updatedAt` on every collection.
- **Response envelope:** success `{ "success": true, "data": ..., "meta"?: ... }`; error `{ "success": false, "error": { "code", "message", "details"?, "requestId" } }`.
- **Pagination:** `?page=1&limit=20` (max 100) → `meta: { page, limit, total, totalPages }`; sort via `?sort=-createdAt`.
- **Layering:** routes → validator → controller (HTTP only) → service (business rules, transactions) → model. Controllers never touch models; services never touch `req/res`.
- **Env/secrets:** backend only; validated at boot; `NODE_ENV` is required and must be explicitly set to an allowed value (`development`, `test`, or `production`). `.env.example` committed, `.env` never.
- **Git:** one branch per phase, conventional commits, PR checklist = phase acceptance criteria.

## 7. Glossary

Order = customer-level purchase + payment. SubOrder = the slice of an order fulfilled by one vendor. Settlement = vendor payout record for one sub-order. GMV = sum of paid order totals.
