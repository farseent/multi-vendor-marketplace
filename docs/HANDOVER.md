# HANDOVER.md

## Current state (after Phase 1: Auth, users, RBAC)

Phase 1 is implemented and awaiting review. Branch: `phase-1-auth`. No Phase 2+ code exists. Phase 0 content below is unchanged unless noted.

- Auth: register / register-vendor / login / refresh (rotation + reuse detection) / logout / me / change-password. Access JWT (HS256, 15 min, claims `sub`, `role`) in memory on the client; opaque 256-bit refresh token in an httpOnly cookie (path `/api/v1/auth`), only its SHA-256 stored.
- Users: `/users/me` (name, phone) and customer-only address CRUD (max 5, exactly one default).
- RBAC: `authenticate`, `authorize(...roles)`, plus a structural guard in `app.js` gating `/api/v1/vendor/*` (role vendor) and `/api/v1/admin/*` (role admin).
- Rate limits (Redis, falling back to per-process memory): global 300/15min/IP, login 10/15min per IP+email, register 5/h/IP (both register routes share it), change-password 10/15min/user.
- Admin accounts: `npm run seed:admin -w server`.
- Client: AuthProvider, ProtectedRoute, login/register/vendor-register/account pages, apiFetch with Bearer token and single-flight refresh.
- Tests: server 111 and client 15 passing in a scratch rebuild (real mongod 7 via mongodb-memory-server). Your repo, Docker Compose and CI not yet run with Phase 1.

## Key decisions

- Module routers declare full paths relative to `/api/v1` with no nested routers; `app.set('apiRouters')` lets tests enumerate every route (`listApiRoutes` in tests/helpers.js).
- Login limiter counts every attempt, not only failures. Suspended accounts get 403 only after the password verifies.
- Refresh: atomic claim (`findOneAndUpdate` on `revokedAt: null`); reuse or a lost race revokes the whole family. `/auth/refresh` and `/auth/logout` reject a browser Origin that is not in CORS_ORIGINS.
- Password: 10-72 chars (72 bytes for bcrypt), a letter and a digit. Bodies use `z.strictObject` (unknown keys -> 422). Validated values are on `req.valid`.
- `BCRYPT_COST` env minimum is 12. Tests build the app with cost 4 for speed.
- Refresh response is `{ user, accessToken }`, the same shape as login.
- JWT carries no `vendorId` yet (vendor records arrive in Phase 2).

## Relevant files

- `server/src/modules/auth/`: model, tokens, validator, service, controller, routes
- `server/src/modules/users/`: model, validator, service, controller, routes
- `server/src/middleware/`: auth.js, rbac.js, validate.js, rateLimit.js, originCheck.js
- `server/src/config/auth.js`, `config/env.js`, `config/constants.js`, `lib/password.js`, `scripts/seedAdmin.js`
- `server/tests/`: auth, users, rbac, rateLimit, seedAdmin, password tests; `db.js` (in-memory replica set)
- `client/src/auth/`, `client/src/pages/{Login,Register,Account}Page.jsx`, `client/src/lib/api.js`

## API changes

| Method       | Path                                      | Auth     | Notes                                                            |
| ------------ | ----------------------------------------- | -------- | ---------------------------------------------------------------- |
| POST         | `/auth/register`, `/auth/register-vendor` | Public   | 201 `{ user, accessToken }` + refresh cookie                     |
| POST         | `/auth/login`                             | Public   | 200 same shape; 401 generic; 403 `ACCOUNT_SUSPENDED`; 429        |
| POST         | `/auth/refresh`                           | Cookie   | 200 `{ user, accessToken }`, rotates cookie; 401 on reuse/expiry |
| POST         | `/auth/logout`                            | Cookie   | idempotent; 200 `{ loggedOut: true }`                            |
| GET          | `/auth/me`                                | Any      | `{ user }`                                                       |
| POST         | `/auth/change-password`                   | Any      | 422 `body.currentPassword` if wrong; revokes other sessions      |
| GET/PATCH    | `/users/me`                               | Any      | name, phone (null clears)                                        |
| GET/POST     | `/users/me/addresses`                     | Customer | 409 at 5 addresses                                               |
| PATCH/DELETE | `/users/me/addresses/:addressId`          | Customer | 404 if not yours; 422 malformed id                               |

New error codes in use: `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `FORBIDDEN`, `ACCOUNT_SUSPENDED`, `RATE_LIMITED` (with `Retry-After`).

Schema changes: new collections `users` (embedded addresses) and `refreshTokens` (TTL index on `expiresAt`), exactly as DATABASE_SCHEMA.md.

## Environment variables (server/.env)

| Variable                                                     | Required  | Notes                                             |
| ------------------------------------------------------------ | --------- | ------------------------------------------------- |
| `JWT_ACCESS_SECRET`                                          | yes       | 32+ chars                                         |
| `REFRESH_TOKEN_TTL_DAYS`                                     | no        | default 30                                        |
| `BCRYPT_COST`                                                | no        | default 12, minimum 12                            |
| `COOKIE_SAME_SITE`                                           | no        | `lax` (default), `strict`, `none` (forces Secure) |
| `TRUST_PROXY`                                                | no        | proxies in front of the API, default 0            |
| `ADMIN_SEED_EMAIL`, `ADMIN_SEED_PASSWORD`, `ADMIN_SEED_NAME` | seed only | read by `seed:admin`, not by the API              |

## Known issues

- Suspended users' access tokens work for up to 15 minutes; other sessions' access tokens survive a password change for up to 15 minutes.
- Two tabs refreshing at the same instant can trigger reuse detection and log the user out.
- Concurrent address edits can raise a Mongoose VersionError (500).
- Limiter waits up to 100 ms per request when Redis is down.
- Not verified in a real environment: docker compose, CI, real Redis for the limiter, UI in a browser.
- Phase 0 items still open: see the earlier list (Docker/CI unverified, noisy Redis warn logs).

## Next-phase prerequisites (Phase 2: Vendors, catalog, uploads)

- Run Phase 1 checks locally (`npm run format && npm run lint && npm test`) and review.
- Decide V5 (same parent domain vs cross-site cookies) before deployment.
- Phase 2 adds `vendorId` to the JWT (or looks it up per request) and per-route approval checks (`VENDOR_NOT_APPROVED`).
- S3 env vars and bucket CORS for presigned PUT; add `categories`, `products`, `vendors` models.
- Vendor routes must be added in module routers under `/vendor/...`; the role guard already applies.
