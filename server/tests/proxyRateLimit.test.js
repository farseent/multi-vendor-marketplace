import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { RATE_LIMITS } from '../src/config/constants.js';
import { createErrorHandler } from '../src/middleware/error.js';
import { createRateLimiter } from '../src/middleware/rateLimit.js';

const logger = { warn() {}, info() {}, error() {} };

// Builds a one-route app whose per-IP limit is 3 requests, with Express's `trust proxy` set to n.
function appBehind(trustProxy) {
  const app = express();
  app.set('trust proxy', trustProxy);
  const limiter = createRateLimiter({
    scope: 'ip',
    windowMs: 60_000,
    max: 3,
    key: (req) => req.ip,
    logger,
  });
  app.get('/x', limiter, (_req, res) => res.json({ success: true }));
  app.use(createErrorHandler({ nodeEnv: 'test', logger }));
  return app;
}

const hit = (app, forwardedFor) => request(app).get('/x').set('X-Forwarded-For', forwardedFor);

async function fourHits(app, forwardedFor) {
  const statuses = [];
  for (let i = 0; i < 4; i += 1) statuses.push((await hit(app, forwardedFor)).status);
  return statuses;
}

// ARCHITECTURE section 8. A change here is a documented-contract change, so it must be deliberate.
describe('rate limit configuration', () => {
  it('matches the documented limits', () => {
    expect(RATE_LIMITS).toMatchObject({
      global: { windowMs: 15 * 60_000, max: 300 },
      login: { windowMs: 15 * 60_000, max: 10 },
      register: { windowMs: 60 * 60_000, max: 5 },
      presign: { windowMs: 60 * 60_000, max: 30 },
      search: { windowMs: 60_000, max: 60 },
      checkout: { windowMs: 60_000, max: 10 },
    });
  });
});

// D69: which address the per-IP limits see depends on TRUST_PROXY, so this pins the behaviour.
describe('per-IP limits behind proxies', () => {
  it('trust proxy 0: a spoofed X-Forwarded-For does not escape the limit', async () => {
    const app = appBehind(0);
    expect(await fourHits(app, '8.8.8.8')).toEqual([200, 200, 200, 429]);
    expect((await hit(app, '9.9.9.9')).status).toBe(429); // same socket address, same bucket
  });

  it('trust proxy 1: the last address in the header is the client, so each one gets its own bucket', async () => {
    const app = appBehind(1);
    expect(await fourHits(app, '1.1.1.1')).toEqual([200, 200, 200, 429]);
    expect((await hit(app, '2.2.2.2')).status).toBe(200);
  });

  it('two proxy hops with trust proxy 1: every visitor shares the first proxy bucket (the D69 pitfall)', async () => {
    const app = appBehind(1);
    await fourHits(app, '1.1.1.1, 9.9.9.9');
    expect((await hit(app, '2.2.2.2, 9.9.9.9')).status).toBe(429);
  });

  it('two proxy hops with trust proxy 2: visitors behind the same proxy are told apart', async () => {
    const app = appBehind(2);
    expect(await fourHits(app, '1.1.1.1, 9.9.9.9')).toEqual([200, 200, 200, 429]);
    expect((await hit(app, '2.2.2.2, 9.9.9.9')).status).toBe(200);
  });
});
