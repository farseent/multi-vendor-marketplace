# HANDOVER.md

## Current state (after Phase 0 — Foundations)

Phase 0 is implemented and awaiting review. Branch: `phase-0-foundations`. No Phase 1+ code exists.

- Monorepo (npm workspaces): `server/` (Express 5, ESM, JavaScript), `client/` (Vite + React 19, React Router, TanStack Query).
- Server: Zod-validated env (fails to boot with exit 1), pino logging with redaction, request-ID, helmet, CORS allowlist, 100 kB JSON limit, central error handler (standard envelope), health endpoints, Mongo/Redis/ES clients, graceful shutdown.
- Client: router shell (`/`, `/status`, 404), `apiFetch` wrapper that unwraps the envelope and throws `ApiError`, a status page that calls `/health/ready`.
- Tooling: ESLint 9 + Prettier, Vitest (server + client), Docker Compose (Mongo replica set, Redis, Elasticsearch), GitHub Actions CI (lint, format check, test, build).
- Tests: 37 server + 5 client, all passing locally. Docker Compose and the CI workflow have NOT been run (no Docker / GitHub in the build environment).

## Key decisions

- Dependency injection: `createApp({nodeEnv, corsOrigins, logger, healthService})`, `createHealthService({checks, logger})`. Nothing reads `process.env` except `server.js`. Tests need no real infrastructure.
- `NODE_ENV` is required (no default) so a production host cannot silently run in development mode. Stack traces appear only when `NODE_ENV=development`.
- `.env` is loaded by `node --env-file-if-exists=.env` (no dotenv). Boot tests run `node src/server.js` directly, so a developer's local `.env` cannot affect them. Needs Node >= 22.9.
- Mongo is required to boot (exit 1 if unreachable). Redis/ES failures are non-fatal; `/health/ready` reports them as `degraded`.
- Health router is mounted at `/health` (probes) and `/api/v1/health` (SPA client).
- ESLint pinned to v9: `eslint-plugin-react` does not yet support v10.
- `@elastic/elasticsearch` pinned to 8.x to match the Elasticsearch 8.15 container.
- Deferred from the ARCHITECTURE §2 middleware chain: rate limiting (needs Redis store, Phase 1), auth/RBAC (Phase 1), Zod `validate` middleware (Phase 1; error handler already maps `ZodError` to 422).

## Relevant files

- `server/src/app.js`, `server.js`, `config/env.js`, `config/constants.js`
- `server/src/lib/`: `AppError.js`, `logger.js`, `db.js`, `redis.js`, `es.js`, `timeout.js`
- `server/src/middleware/`: `requestId.js`, `httpLogger.js`, `error.js`
- `server/src/modules/health/`: `health.routes.js`, `health.controller.js`, `health.service.js`
- `server/tests/`: `env`, `app`, `health`, `logger` tests + `helpers.js`
- `client/src/lib/api.js`, `pages/`, `components/Layout.jsx`
- `docker-compose.yml`, `.github/workflows/ci.yml`, `eslint.config.js`, `.prettierrc`

## API changes

| Method | Path                                    | Auth   | Notes                                                                             |
| ------ | --------------------------------------- | ------ | --------------------------------------------------------------------------------- |
| GET    | `/health`, `/api/v1/health`             | Public | Liveness: `data: { status: "ok", uptimeSeconds }`                                 |
| GET    | `/health/ready`, `/api/v1/health/ready` | Public | `data: { status: "ok"\|"degraded", components: { mongo, redis, elasticsearch } }` |

Each component: `{ status: "up"|"down", required, latencyMs? }`. If Mongo is down: 503 with error code `SERVICE_UNAVAILABLE` and `error.details = { status: "unavailable", components }`. Connection error text is never returned.

New error codes: `SERVICE_UNAVAILABLE` (503). Error handler also maps: Zod -> 422 `VALIDATION_ERROR`, malformed/oversized JSON -> 400 `BAD_REQUEST`, Mongoose `ValidationError` -> 422, `CastError` -> 400, duplicate key 11000 -> 409 `CONFLICT`, unknown -> 500 `INTERNAL_ERROR`.

Schema changes: none.

## Environment variables (`server/.env`, see `server/.env.example`)

| Variable            | Required | Notes                                                   |
| ------------------- | -------- | ------------------------------------------------------- |
| `NODE_ENV`          | yes      | `development` \| `test` \| `production`                 |
| `MONGODB_URI`       | yes      | `mongodb://` or `mongodb+srv://`; must be a replica set |
| `REDIS_URL`         | yes      | `redis://` or `rediss://`                               |
| `ELASTICSEARCH_URL` | yes      | `http(s)://`                                            |
| `CORS_ORIGINS`      | yes      | Comma-separated exact origins, no trailing slash        |
| `PORT`              | no       | Default 4000                                            |
| `LOG_LEVEL`         | no       | Default `info`                                          |

Client (optional): `VITE_API_URL` (public values only). Default `/api/v1` via Vite proxy.

## Known issues

- Not verified in a real environment: `docker compose up`, the Mongo replica-set healthcheck, ES healthcheck, real Redis/ES/Mongo health pings, CI on GitHub.
- Redis connection errors are logged at `warn` on every retry (max every 5 s) and can be noisy while Redis is down.
- No `trust proxy` setting yet; needed before IP-based rate limiting behind a proxy (Phase 1/9).
- `mongodb-memory-server` not installed yet (add in Phase 1 for model/transaction tests).

## Next-phase prerequisites (Phase 1: Auth, users, RBAC)

- Run the Phase 0 acceptance checks on your machine (README "Run locally").
- Add env vars: JWT secret, access/refresh settings, bcrypt cost, admin seed credentials.
- Add `mongodb-memory-server` (replica set mode) and the shared `validate` middleware.
- Decide V5 early (frontend/backend domains: same parent domain or cross-site cookies).
