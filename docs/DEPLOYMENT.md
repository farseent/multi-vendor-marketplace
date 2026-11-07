# DEPLOYMENT.md

Phase 9. Frontend and backend are deployed separately (D68). Nothing here has been run yet: every step is **not run** until you record a result in `docs/HANDOVER.md`.

## Topology

| Part      | Host                    | Notes                                                                                       |
| --------- | ----------------------- | ------------------------------------------------------------------------------------------- |
| React app | Vercel (root `client/`) | `client/vercel.json` forwards `/api/*` to the backend, so the browser sees one origin (D69) |
| API       | Render web service      | `render.yaml`; liveness check `/health`                                                     |
| MongoDB   | Atlas M0                | a replica set, which the transactions need                                                  |
| Redis     | Upstash (`rediss://`)   | cache and rate limiter only (D13)                                                           |
| Search    | none (Mongo fallback)   | `ELASTICSEARCH_URL` unset (D70)                                                             |
| Images    | S3 bucket               | browser PUTs with presigned URLs                                                            |
| Payments  | Razorpay **test** mode  | the mock provider is refused when `NODE_ENV=production`                                     |

Free-tier limits change: check each host's current terms before relying on them.

## Order of work

1. **Atlas.** Create a free cluster and a database user, allow the Render outbound IPs (or `0.0.0.0/0` for a demo), copy the `mongodb+srv://` URI. Confirm transactions work (the checkout test needs them).
2. **Upstash.** Create a Redis database, copy the `rediss://` URL.
3. **S3.** Bucket with public read only under `products/*`, an IAM user limited to `PutObject` on that prefix, and this bucket CORS (the browser uploads from the page origin, which is the Vercel origin):
   ```json
   [
     {
       "AllowedOrigins": ["https://YOUR-APP.vercel.app"],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["Content-Type"],
       "MaxAgeSeconds": 300
     }
   ]
   ```
4. **Render.** New Blueprint from the repo (`render.yaml`), then fill the `sync: false` variables. Generate the JWT secret with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. `CORS_ORIGINS` is exactly the Vercel origin, with no path or trailing slash.
5. **Vercel.** Import the repo with root directory `client`. Edit the destination host in `client/vercel.json` to your Render URL and redeploy. Do **not** set `VITE_API_URL`.
6. **Create the admin and demo data** (from your machine, pointing at Atlas). Put a strong, private `ADMIN_SEED_PASSWORD` in your local `server/.env` first: the value in `.env.example` is public. The demo accounts all use the shared password in `server/src/scripts/demoData.js`, so seed demo data only on a demo database:
   ```
   npm run seed:admin
   SEED_API_URL=https://YOUR-APP.vercel.app/api/v1 npm run seed:demo
   ```
7. **Check the client IP the API sees** (D69). Log in from your phone on mobile data, then compare the `ip` stored on your `refreshTokens` record in Atlas with your public IP. If it shows a Vercel/Render address, change `TRUST_PROXY` (try 1, then 2) until it matches. Wrong values make every visitor share one rate-limit bucket.
8. **Razorpay webhook.** Point the Dashboard webhook at `https://YOUR-BACKEND.onrender.com/api/v1/webhooks/razorpay` (the Render URL directly, not the Vercel rewrite) and use its secret as `RAZORPAY_WEBHOOK_SECRET`. The manual test script in `TESTING.md` section 4 still applies.

## Known limits of the free hosts

- A free Render service sleeps when idle, so the in-process jobs (D17: reservation release, reconcile, settlement release) only run while it is awake, and the first request after sleep is slow. For a real demo day use a paid instance or ping `/health`.
- Without Elasticsearch, search uses the Mongo text index: no typo tolerance, simpler ranking. If you add Elasticsearch later, set `ELASTICSEARCH_URL` and run `npm run reindex` once (the outbox is not written while it is unset).
- Checkout on the deployed site needs a working Razorpay test setup (Route, linked accounts). Until the deferred manual runs are done, browsing, login, vendor and admin screens can be demonstrated but a paid order cannot.

## If the cookie does not survive the rewrite

Use a custom domain so the app and API share a parent domain (for example `shop.example.com` and `api.example.com`), set `VITE_API_URL` to the API URL, keep `COOKIE_SAME_SITE=lax` and put both origins in `CORS_ORIGINS` only if needed. Cross-site hosting with `COOKIE_SAME_SITE=none` also works but is blocked by some browsers' third-party cookie settings, which is why it is not the default.

## Smoke test

Run it against a LOCAL API started with `TRUST_PROXY=1` (see the header of `server/src/scripts/smoke.js`):

```
npm run smoke              # 50 connections, 120 s, exits 1 above 1% errors
```
