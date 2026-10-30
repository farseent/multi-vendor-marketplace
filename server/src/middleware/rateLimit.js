import { createHash } from 'node:crypto';
import { RATE_LIMITS } from '../config/constants.js';
import { AppError } from '../lib/AppError.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** Per-process fixed-window counter. Used when Redis is absent or failing (never "off"). */
class MemoryCounter {
  #hits = new Map();

  hit(key, windowMs) {
    const now = Date.now();
    if (this.#hits.size > 5000) this.#prune(now);
    let entry = this.#hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.#hits.set(key, entry);
    }
    entry.count += 1;
    return { count: entry.count, retryAfterMs: entry.resetAt - now };
  }

  #prune(now) {
    for (const [key, entry] of this.#hits) if (entry.resetAt <= now) this.#hits.delete(key);
  }
}

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref()),
  ]);

/**
 * Fixed-window limiter. Redis is preferred (shared between instances); if Redis errors or is
 * slower than 100 ms we fall back to the in-memory counter and log at `warn` (D13).
 * `key(req)` returns the identity being limited; it must not contain raw PII (hash it).
 */
export function createRateLimiter({ scope, windowMs, max, key, redis = null, logger }) {
  const memory = new MemoryCounter();
  let lastWarnAt = 0;

  async function hit(redisKey) {
    if (redis) {
      try {
        // SET NX PX + INCR + PTTL in one MULTI: the key always gets a TTL, even if we crash.
        const results = await withTimeout(
          redis.multi().set(redisKey, 0, 'PX', windowMs, 'NX').incr(redisKey).pttl(redisKey).exec(),
          100,
        );
        const failed = results.find(([err]) => err);
        if (failed) throw failed[0];
        return { count: results[1][1], retryAfterMs: results[2][1] };
      } catch (err) {
        if (Date.now() - lastWarnAt > 30_000) {
          lastWarnAt = Date.now();
          logger.warn({ err: err.message, scope }, 'Rate limiter using in-memory fallback');
        }
      }
    }
    return memory.hit(redisKey, windowMs);
  }

  return async (req, res, next) => {
    try {
      const { count, retryAfterMs } = await hit(`rl:${scope}:${key(req)}`);
      if (count > max) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
        throw new AppError('RATE_LIMITED', 429, 'Too many requests, please try again later');
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** The limiters built from RATE_LIMITS. */
export function createLimiters({ redis, logger }) {
  const make = (scope, key) =>
    createRateLimiter({ scope, ...RATE_LIMITS[scope], key, redis, logger });

  return {
    global: make('global', (req) => req.ip),
    // Counts every attempt (not only failures): a 429 must not reveal whether the password was right.
    login: make('login', (req) => {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      return `${req.ip}:${sha256(email)}`;
    }),
    register: make('register', (req) => req.ip),
    changePassword: make('changePassword', (req) => req.user.id),
    // 30/hour per vendor user (one shop per user, so this is per shop). Phase 2.
    presign: make('presign', (req) => req.user.id),
  };
}
