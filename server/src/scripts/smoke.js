// npm run smoke   Load smoke test (Phase 9): 50 connections for 120 s against a running API.
// Pass: error rate under 1% (IMPLEMENTATION_PLAN Phase 9). Exit code 1 otherwise.
//
// Env: SMOKE_URL (default http://localhost:4000), SMOKE_CONNECTIONS (50), SMOKE_DURATION (120 s).
//
// Rate limits: every request carries a random X-Forwarded-For, so the per-IP limits (global 300 per
// 15 min, search 60 per minute) do not turn one test machine into "a single abusive client".
// That header is only honoured when the API runs with TRUST_PROXY >= 1, so start a LOCAL API with
// TRUST_PROXY=1 for this test. Do not run it against a public deployment you do not own.
import autocannon from 'autocannon';
import { pathToFileURL } from 'node:url';

export const ERROR_RATE_LIMIT = 0.01;

/** Share of requests that failed: transport errors, timeouts and non-2xx answers. */
export function errorRate(result) {
  const total = result.requests.total + result.errors + result.timeouts;
  if (total === 0) return 1; // nothing answered at all is a failure, not a pass
  return (result.errors + result.timeouts + result.non2xx) / total;
}

const randomIp = () =>
  Array.from({ length: 4 }, () => 1 + Math.floor(Math.random() * 253)).join('.');

/** The traffic mix: public reads only (no writes, so it can run against a seeded database). */
export const PATHS = [
  '/health',
  '/api/v1/categories',
  '/api/v1/products/search?q=cotton',
  '/api/v1/products/search?sort=price&page=1&limit=20',
];

export function runSmoke({ url = 'http://localhost:4000', connections = 50, duration = 120 } = {}) {
  return new Promise((resolve, reject) => {
    const instance = autocannon(
      {
        url,
        connections,
        duration,
        requests: PATHS.map((path) => ({
          method: 'GET',
          path,
          setupRequest: (req) => {
            req.headers = { ...req.headers, 'x-forwarded-for': randomIp() };
            return req;
          },
        })),
      },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
    autocannon.track(instance, { renderProgressBar: false, renderResultsTable: false });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = {
    url: process.env.SMOKE_URL,
    connections: Number(process.env.SMOKE_CONNECTIONS) || undefined,
    duration: Number(process.env.SMOKE_DURATION) || undefined,
  };
  const result = await runSmoke(options);
  const rate = errorRate(result);
  console.log(
    JSON.stringify({
      requests: result.requests.total,
      non2xx: result.non2xx,
      errors: result.errors,
      timeouts: result.timeouts,
      errorRatePercent: Number((rate * 100).toFixed(3)),
      latencyP99Ms: result.latency.p99,
      requestsPerSecAvg: result.requests.average,
    }),
  );
  process.exit(rate < ERROR_RATE_LIMIT ? 0 : 1);
}
