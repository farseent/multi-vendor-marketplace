import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createErrorHandler } from '../src/middleware/error.js';
import { createRateLimiter } from '../src/middleware/rateLimit.js';
import { silentLogger } from './helpers.js';

function appWith(limiter) {
  const app = express();
  app.get('/x', limiter, (_req, res) => res.json({ success: true }));
  app.use(createErrorHandler({ nodeEnv: 'test', logger: silentLogger }));
  return app;
}
const options = {
  scope: 't',
  windowMs: 60_000,
  max: 3,
  key: (req) => req.ip,
  logger: silentLogger,
};

/** Minimal fake of the ioredis calls the limiter uses. */
function fakeRedis({ fail = false } = {}) {
  const store = new Map();
  return {
    store,
    multi() {
      const ops = [];
      const chain = {
        set(key) {
          ops.push(() => {
            if (!store.has(key)) store.set(key, 0);
            return [null, 'OK'];
          });
          return chain;
        },
        incr(key) {
          ops.push(() => {
            store.set(key, store.get(key) + 1);
            return [null, store.get(key)];
          });
          return chain;
        },
        pttl() {
          ops.push(() => [null, 55_000]);
          return chain;
        },
        async exec() {
          if (fail) throw new Error('connection refused');
          return ops.map((op) => op());
        },
      };
      return chain;
    },
  };
}

describe('createRateLimiter', () => {
  it('allows `max` requests then answers 429 RATE_LIMITED with Retry-After', async () => {
    const app = appWith(createRateLimiter(options));
    for (let i = 0; i < 3; i++) expect((await request(app).get('/x')).status).toBe(200);
    const res = await request(app).get('/x');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('starts a fresh window after windowMs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const app = appWith(createRateLimiter({ ...options, max: 1 }));
      expect((await request(app).get('/x')).status).toBe(200);
      expect((await request(app).get('/x')).status).toBe(429);
      vi.setSystemTime(Date.now() + 61_000);
      expect((await request(app).get('/x')).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses Redis when available (shared counters) and derives Retry-After from PTTL', async () => {
    const redis = fakeRedis();
    const app = appWith(createRateLimiter({ ...options, redis, max: 1 }));
    await request(app).get('/x');
    const res = await request(app).get('/x');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('55');
    expect([...redis.store.keys()][0]).toMatch(/^rl:t:/);
  });

  // Acceptance (Phase 3 also checks this end to end): "auth limiter still enforces limits"
  it('falls back to the in-memory counter when Redis fails: still enforces the limit, never 5xx', async () => {
    const warn = vi.fn();
    const limiter = createRateLimiter({
      ...options,
      redis: fakeRedis({ fail: true }),
      logger: { warn },
    });
    const app = appWith(limiter);
    for (let i = 0; i < 3; i++) expect((await request(app).get('/x')).status).toBe(200);
    expect((await request(app).get('/x')).status).toBe(429);
    expect(warn).toHaveBeenCalledTimes(1); // throttled, not once per request
  });
});
