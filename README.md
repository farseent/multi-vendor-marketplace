# Multi-Vendor Marketplace

Portfolio-quality, Amazon-style multi-vendor marketplace (MERN + Elasticsearch + Redis + S3).
Planning documents live in [`docs/`](docs/); current implementation state is in
[`docs/HANDOVER.md`](docs/HANDOVER.md).

## Prerequisites

Node.js 22.9 or newer, Docker with Compose v2.

## Run locally

```bash
docker compose up -d --wait        # MongoDB (replica set), Redis, Elasticsearch
cp server/.env.example server/.env # then adjust if needed
npm install
npm run dev:server                 # API on http://localhost:4000
npm run dev:client                 # React app on http://localhost:5173
```

Check it works: `curl localhost:4000/health/ready`, or open http://localhost:5173/status.

## Scripts

| Command               | What it does                                  |
| --------------------- | --------------------------------------------- |
| `npm test`            | Server and client tests (no Docker needed)    |
| `npm run lint`        | ESLint across the monorepo                    |
| `npm run format`      | Prettier write (`format:check` only verifies) |
| `npm run build`       | Production build of the client                |
| `docker compose down` | Stop infrastructure (`-v` also wipes data)    |
