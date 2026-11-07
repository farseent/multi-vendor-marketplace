# Multi-Vendor Marketplace

Portfolio-quality, Amazon-style multi-vendor marketplace (MERN + Elasticsearch + Redis + S3). Customers buy from several vendors in one checkout, vendors run their own shops, and the platform earns a commission on each vendor's sales.

Planning documents live in [`docs/`](docs/); current implementation state is in [`docs/HANDOVER.md`](docs/HANDOVER.md).

## Architecture

```
React (Vite) ──/api/v1──▶ Express API (modular monolith) ──▶ MongoDB (replica set, transactions)
 customer / vendor /        auth · catalog · search · cart     Redis  (cache + rate limits, optional)
 admin screens              checkout · payments · refunds      Elasticsearch (optional, Mongo fallback)
                            settlements · reviews · invoices   S3 (images via presigned PUT)
                            admin analytics · background jobs  Razorpay Route (test mode) behind a PaymentProvider
```

Why it is built this way is recorded in [`docs/DECISIONS.md`](docs/DECISIONS.md); data flows are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Prerequisites

Node.js 22.9 or newer, Docker with Compose v2.

## Run locally

```bash
docker compose up -d --wait        # MongoDB (replica set), Redis, Elasticsearch
cp server/.env.example server/.env # then adjust if needed
npm install
npm run seed:admin                 # creates the admin from ADMIN_SEED_* in server/.env
npm run dev:server                 # API on http://localhost:4000
npm run dev:client                 # React app on http://localhost:5173
npm run seed:demo                  # (optional, second terminal) demo shops, products, coupon
```

Check it works: `curl localhost:4000/health/ready`, or open http://localhost:5173/status.

Demo logins after `seed:demo`: the admin from your `.env`, vendors `loom@demo.example`, `copper@demo.example` and `leaf@demo.example`, and customer `customer@demo.example`. They share the password in `server/src/scripts/demoData.js`: use it on a demo database only. Coupon: `WELCOME10`. Demo products have no real images; upload one through the vendor screens if you have S3 configured.

Without `ELASTICSEARCH_URL` the API runs on the Mongo search fallback. Without `S3_BUCKET`, uploads answer 503.

## Scripts

| Command               | What it does                                                          |
| --------------------- | --------------------------------------------------------------------- |
| `npm test`            | Server and client tests (the server tests start an in-memory MongoDB) |
| `npm run lint`        | ESLint across the monorepo                                            |
| `npm run format`      | Prettier write (`format:check` only verifies)                         |
| `npm run build`       | Production build of the client                                        |
| `npm run audit`       | `npm audit`, failing on high or critical findings (also run in CI)    |
| `npm run seed:admin`  | Create the admin account                                              |
| `npm run seed:demo`   | Fill a running API with demo data through its HTTP API                |
| `npm run reindex`     | Rebuild the Elasticsearch index from MongoDB                          |
| `npm run smoke`       | 50-connection, 120 s load smoke test (see the header of the script)   |
| `docker compose down` | Stop infrastructure (`-v` also wipes data)                            |

## Deploying

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) (Vercel + Render + Atlas + Upstash + S3) and [`render.yaml`](render.yaml). Security review: [`docs/SECURITY_CHECKLIST.md`](docs/SECURITY_CHECKLIST.md). Test strategy and acceptance checks: [`docs/TESTING.md`](docs/TESTING.md).

## Screenshots

To be added after the first deployment.
