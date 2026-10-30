# HANDOVER.md

## Current state (after Phase 2: Vendors, catalog, uploads)

Phase 2 is implemented and its tests pass (see "Verification" for exactly what was and was not run). Branch: `phase-2-vendors-catalog`. No Phase 3+ code exists. Phase 1 (auth, users, RBAC) is unchanged except for the additions listed below.

- **Shops:** a vendor user creates one shop (`POST /vendor/profile`, status `pending`, slug derived from the name and kept stable). Admins list vendors, approve / reject / suspend (transition table, 409 otherwise) and set a commission override (0-5000 bps, `null` clears it). Public `GET /shops/:shopSlug` answers only for `approved` shops and returns no private fields.
- **Categories:** admin create/list/update, two levels max, unique slug. Public `GET /categories` returns the tree of active categories (not cached yet).
- **Products:** vendor CRUD under `/vendor/products`, every query scoped by the vendor id taken from the shop record (never from body, params or token). Another vendor's product is `404` for GET, PATCH, DELETE and stock. `DELETE` archives. Stock is changed only through `PATCH .../stock` (absolute set). Setting `status: active` needs an approved shop (`403 VENDOR_NOT_APPROVED`). Public `GET /products/:slug` returns only `active` products of `approved` shops, through an explicit allow-list of fields (no `stockQty`, `sku`, `vendorId`).
- **Uploads:** `POST /vendor/uploads/presign` returns a short-lived presigned PUT URL for `products/{vendorId}/{uuid}.{jpg|png|webp}`. Type and exact size are part of the signature. Product images and shop logos must use keys inside the vendor's own prefix (422 otherwise). Without `S3_BUCKET` the API still boots and presign answers 503.
- **Audit:** every admin mutation added in this phase writes an `auditLogs` entry (vendor status, commission, category create/update).
- **Client:** `/vendor/shop` (create/edit shop, status banner), `/vendor/products` (list, filter, paginate, archive), `/vendor/products/new` and `/vendor/products/:productId` (form, image upload, separate stock form), public `/products/:slug`. Prices are typed in rupees and converted to integer paise with string math (`lib/money.js`). Role-gated routes are UX only; the API enforces roles.
- **Not in Phase 2 (by plan):** search, Redis caching, admin console UI (approve vendors via API for now), payout account, admin product moderation, vendor dashboard.

## Key decisions

- **D28 Vendor identity is looked up per request.** `middleware/shop.js` (`loadShop`) finds the shop by `req.user.id` and sets `req.vendor = { id, status }`. The JWT is unchanged (no `vendorId` claim), so approval or suspension applies immediately instead of after 15 minutes. Cost: one indexed query per vendor request. A vendor without a shop gets `403 FORBIDDEN` on product and upload routes.
- **D29 S3 is optional at boot.** `S3_BUCKET` / `S3_REGION` / `S3_PUBLIC_BASE_URL` are optional; presign answers `503 SERVICE_UNAVAILABLE` and image URLs are `null` when unset. Tests inject a fake storage object with the same two functions (`presignPut`, `publicUrl`).
- **D30 Admin mutations are audited from now on** (ARCHITECTURE section 6), via `modules/audit`. Phase 8 only has to add coverage for the later admin routes.
- **D31 Stock is not editable through product PATCH** (strict body rejects it); only `PATCH /vendor/products/:id/stock`, an atomic absolute set scoped to the owner. A form save can therefore never overwrite newer stock.
- **D32 Shop logos use the same `products/{vendorId}/` prefix as product images,** so the bucket needs a single public-read rule. A logo can only be set via PATCH after the shop exists (the prefix contains the vendor id).
- Pending shops may create draft products and use presign (drafts need images). Only publishing needs approval. Suspended or rejected shops cannot publish; their active products are invisible publicly because the public query also requires an approved shop.
- A product suspended by an admin cannot be restored or archived by its vendor (409 `INVALID_STATE_TRANSITION`); other fields stay editable.
- Module naming: shops model lives in `modules/shops` (collection `vendors`); `modules/catalog` holds two sub-modules, `categories.*` and `products.*`.
- Vendor status transitions: `pending -> approved|rejected`, `approved -> suspended`, `suspended -> approved`, `rejected -> approved`. Applied with a conditional update so two admins cannot both win.
- Mongoose 9: use `returnDocument: 'after'` (not `new: true`) in `findOneAndUpdate`.

## Relevant files

- `server/src/modules/shops/` (model, validator, service, controller, routes), `modules/catalog/` (`categories.*`, `products.*`), `modules/uploads/`, `modules/audit/`
- `server/src/middleware/shop.js` (loadShop), `rateLimit.js` (new `presign` limiter)
- `server/src/lib/`: `s3.js`, `slug.js`, `pagination.js`, `uploadKeys.js`
- `server/src/config/constants.js` (Phase 2 constants, `VENDOR_TRANSITIONS`, `UPLOAD`), `config/env.js` (S3 vars), `app.js`, `server.js` (storage + index init)
- `server/tests/`: `shops`, `catalog`, `uploads`, `phase2.unit` tests; `factories.js`; `db.js`, `helpers.js` (`fakeStorage`), `rbac.test.js` updated
- `client/src/pages/` (`VendorShopPage`, `VendorProductsPage`, `VendorProductFormPage`, `ProductPage`, `catalog.css`), `components/ImageUploader.jsx`, `lib/money.js`, `lib/uploads.js`

## API changes

| Method               | Path                                  | Auth          | Notes                                                                                                                  |
| -------------------- | ------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GET                  | `/categories`                         | Public        | tree `[{ id, name, slug, children }]`, active only                                                                     |
| GET                  | `/products/:slug`                     | Public        | active product of approved shop; else 404. Phase 3: register `/products/search` BEFORE this route                      |
| GET                  | `/shops/:shopSlug`                    | Public        | approved only; `{ id, shopName, shopSlug, description, logoUrl }`                                                      |
| GET / POST / PATCH   | `/vendor/profile`                     | Vendor        | GET 404 until created; POST 201 once (409 after); PATCH `shopName`, `description`, `logoKey` (null clears)             |
| GET / POST           | `/vendor/products`                    | Vendor + shop | list `?status&sort&page&limit`; create (default `status: draft`)                                                       |
| GET / PATCH / DELETE | `/vendor/products/:productId`         | Vendor + shop | 404 if not owned; DELETE archives (idempotent)                                                                         |
| PATCH                | `/vendor/products/:productId/stock`   | Vendor + shop | `{ stockQty }` integer 0..1,000,000                                                                                    |
| POST                 | `/vendor/uploads/presign`             | Vendor + shop | `{ contentType, sizeBytes }` -> 201 `{ uploadUrl, method, headers, key, publicUrl, expiresInSeconds }`; 30/hour/vendor |
| GET                  | `/admin/vendors`                      | Admin         | `?status&page&limit`, includes `owner { id, name, email }`                                                             |
| PATCH                | `/admin/vendors/:vendorId/status`     | Admin         | `{ status: approved\|rejected\|suspended }`                                                                            |
| PATCH                | `/admin/vendors/:vendorId/commission` | Admin         | `{ commissionRateBps: 0..5000 \| null }`                                                                               |
| GET / POST           | `/admin/categories`                   | Admin         | flat list incl. inactive / create                                                                                      |
| PATCH                | `/admin/categories/:categoryId`       | Admin         | partial update                                                                                                         |

Error codes used: `VENDOR_NOT_APPROVED` (403), `INVALID_STATE_TRANSITION` (409), `SERVICE_UNAVAILABLE` (503), plus existing ones. Product images in vendor responses carry `{ key, alt?, url }`.

Schema changes: new collections `vendors`, `categories`, `products`, `auditLogs`, exactly as DATABASE_SCHEMA.md (indexes created by `Model.init()` at boot). No changes to `users` / `refreshTokens`.

## Environment variables (server/.env)

| Variable                                     | Required                | Notes                                                                           |
| -------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| `S3_BUCKET`                                  | no                      | enables uploads; without it presign answers 503                                 |
| `S3_REGION`                                  | only if `S3_BUCKET` set | e.g. `ap-south-1`                                                               |
| `S3_PUBLIC_BASE_URL`                         | no                      | CDN / base URL for images; default `https://<bucket>.s3.<region>.amazonaws.com` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | when uploads are used   | standard AWS variables read by the SDK; never commit, never in the frontend     |

New dependencies (server): `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`. Run `npm install` at the repo root to refresh `package-lock.json`.

S3 bucket setup (not yet exercised against real AWS): block public listing; allow public `GetObject` only on `products/*`; CORS must allow `PUT` from the frontend origin with header `Content-Type`.

## Dev workflow for approving a vendor (no admin UI yet)

1. `npm run seed:admin -w server`, then log in as the admin (`POST /api/v1/auth/login`) to get an access token.
2. `GET /api/v1/admin/vendors?status=pending` to find the shop id.
3. `PATCH /api/v1/admin/vendors/<id>/status` with `{ "status": "approved" }`.
4. Create at least one category: `POST /api/v1/admin/categories` with `{ "name": "Clothing" }`.

## Verification

Run in a reconstructed copy of the repo with a real MongoDB 8.3.7 (replica set via mongodb-memory-server, system binary): 148 server tests passing (new: shops 15, catalog 41, uploads 19, unit 20; plus the existing `users` and updated `rbac` suites); 32 client tests passing (new: money 22, uploads 2; plus `access`); `vite build` succeeded. A real `createStorage` call produced a URL whose signature covers `content-length` and `content-type`. Not run: the other Phase 1 suites that were not shared (auth, password, rateLimit, seedAdmin, env, app, health, logger), your real ESLint/Prettier configs and CI, real S3, a real browser.

## Known issues

- Upload enforcement by S3 (size and type in the signature) is verified only by inspecting the signed URL, not with a real upload; bucket CORS is unverified.
- Images uploaded but never saved on a product stay in S3 (no cleanup). Phase 9: lifecycle rule.
- Deactivating a category does not hide its products; it only blocks new products in it.
- No admin endpoint exists yet to suspend a product (`PATCH /admin/products/:id/status` is Phase 8); the vendor-side suspended rules are tested by setting the status directly.
- Product PATCH uses load-modify-save: concurrent edits of different fields merge, the same field is last-write-wins.
- Client has no UI for product attributes or shop logo (the API supports both) and no public shop page yet.
- Phase 1 known issues (access tokens valid up to 15 min after suspension or password change, two-tab refresh race, address VersionError, 100 ms limiter wait with Redis down) are unchanged.

## Next-phase prerequisites (Phase 3: Search + caching)

- Review and approve Phase 2, then create the branch.
- Product writes (create, update, status change, stock crossing zero) and vendor status changes must enqueue `searchOutbox` entries in the same transaction as the write. Phase 2 product writes are plain saves and will need to move into transactions.
- Register `GET /products/search` before `GET /products/:slug` in `products.routes.js`.
- Add cache invalidation for `cache:product:{slug}` and `cache:categories` (category changes in `categories.service.js`, product changes in `products.service.js`).
- Decide ES/Redis hosting (V4) if deploying soon.
