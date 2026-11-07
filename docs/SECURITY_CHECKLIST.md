# SECURITY_CHECKLIST.md

Phase 9 review. "Read" means the item was checked by reading the source in this phase; it is **not** a runtime test. "Test" names an automated test that covers it. "Open" means not reviewed or not verified yet.

## Transport, headers, CORS

| Item                                                                     | Status | Evidence                                                                                                                               |
| ------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `helmet()` with default headers on every response                        | Read   | `app.js`                                                                                                                               |
| CORS allows only the exact origins in `CORS_ORIGINS`, with credentials   | Read   | `app.js`; origins must look like `https://host[:port]` (`config/env.js`, `env.test.js`)                                                |
| CSRF defence on cookie routes: `Origin`, if present, must be allowlisted | Read   | `originCheck.js`, used on `/auth/refresh` and `/auth/logout`                                                                           |
| HTTPS only in production                                                 | Open   | Provided by Render/Vercel; cookie is `Secure` when `NODE_ENV=production` (`config/auth.js`)                                            |
| Deployed CORS rejects a foreign origin                                   | Open   | Run: `curl -i -H "Origin: https://evil.example" https://BACKEND/api/v1/categories` and confirm no `Access-Control-Allow-Origin` header |

## Authentication and sessions

| Item                                                                          | Status | Evidence                                                                                |
| ----------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| Refresh token httpOnly, path-scoped to `/api/v1/auth`, `Secure` in production | Read   | `auth.controller.js`, `config/auth.js`                                                  |
| Access token in memory only, never `localStorage`                             | Read   | `client/src/lib/api.js`                                                                 |
| bcrypt cost cannot go below 12                                                | Read   | `config/env.js` (`BCRYPT_COST` min 12)                                                  |
| Placeholder JWT secret refused in production                                  | Test   | `env.test.js` (new, Phase 9)                                                            |
| Mock payment provider refused in production                                   | Test   | `env.test.js` / `phase5a.unit.test.js`                                                  |
| Login 10 / 15 min per IP + email; register 5 / hour; others as documented     | Test   | `rateLimit.test.js`, `proxyRateLimit.test.js` (limits pinned to ARCHITECTURE section 8) |
| Rotation and reuse detection                                                  | Test   | `auth.test.js` (existing)                                                               |

## Input, errors, logging

| Item                                                               | Status | Evidence                                                                                                |
| ------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------- |
| JSON body limit 100 kB; webhook raw body 256 kB                    | Read   | `constants.js`, `app.js`                                                                                |
| Stack traces only when `NODE_ENV=development`                      | Read   | `middleware/error.js`; production returns code, message and `requestId` only                            |
| Secrets redacted in logs (authorization, cookie, password, tokens) | Read   | `lib/logger.js` (one nesting level); `logger.test.js`                                                   |
| Env validation errors never echo values                            | Test   | `env.test.js`                                                                                           |
| Zod `.strict()` on every validator                                 | Open   | Only the auth validator was provided; confirm with `grep -L strict server/src/modules/*/*.validator.js` |
| Rate-limit keys avoid raw email (hashed)                           | Read   | `rateLimit.js`                                                                                          |

## Authorization and data

| Item                                                           | Status | Evidence                                                                                                                    |
| -------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| `/vendor/*` and `/admin/*` role-gated structurally             | Read   | `app.js`; route-table test in `rbac.test.js` (existing)                                                                     |
| Cross-tenant 404s, invoice ownership, audit of admin mutations | Test   | Existing suites (`catalog`, `invoices`, `adminAudit`); not re-reviewed in Phase 9                                           |
| Webhook signature verification                                 | Open   | Covered by `payments.test.js` and `razorpay.provider.test.js`; code not re-read in Phase 9                                  |
| S3 presign constraints (type, size, key prefix)                | Open   | `uploads.service.js` was not re-reviewed; IMPLEMENTATION_PLAN Phase 2 still lists two unchecked presign/validation criteria |

## Supply chain

| Item                                  | Status    | Evidence                                                                                                                                    |
| ------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| No high/critical `npm audit` findings | Owner-run | You reported 0 vulnerabilities at the root, in `client/` and in `server/` on 2026-11-07; CI now fails on high or critical (`npm run audit`) |

## Findings from this review

1. **The `.env.example` JWT secret passes the length rule.** Fixed: production now refuses any secret starting with `change-me`.
2. **`seed:admin` was referenced by `.env.example` but missing from `server/package.json`.** Fixed: added `seed:admin`, plus `seed:demo` and `smoke`.
3. **`ADMIN_SEED_PASSWORD` in `.env.example` is public.** Not a code fix: use your own value (documented in `DEPLOYMENT.md`).
4. **Per-IP limits depend on `TRUST_PROXY`.** With the Vercel rewrite in front of Render, 1 makes all visitors share one bucket and 2 separates them (pinned in `proxyRateLimit.test.js`). The real value on your hosts must be verified (`DEPLOYMENT.md` step 7).
5. **The global limit (300 per 15 min per IP) is low for several people behind one shared address** (a college network, say). It is unchanged (D71); raise `RATE_LIMITS.global.max` if a demo needs it.
6. **Health output is public** and lists component latencies but no hostnames or error text. Acceptable.
