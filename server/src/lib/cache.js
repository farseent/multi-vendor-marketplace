import { CACHE } from '../config/constants.js';
import { withTimeout } from './timeout.js';

/**
 * Fail-open JSON cache over Redis (D13). Every call has a 100 ms timeout; any error (Redis down,
 * slow, bad JSON) is logged at `warn` and treated as a miss, never thrown to the caller.
 * `redis` may be null (tests, or Redis not configured): then every call is a cheap no-op.
 */
export function createCache({ redis = null, logger }) {
  let lastWarnAt = 0;
  // After a failure, reads/writes skip Redis for a few seconds instead of each paying the full
  // 100 ms timeout (a product page does a get AND a set). Deletes are always attempted, so
  // invalidation is never skipped just because the breaker is open.
  let skipUntil = 0;
  const open = () => Date.now() < skipUntil;
  const warn = (op, err) => {
    skipUntil = Date.now() + CACHE.breakerMs;
    // Rate-limit the log so a Redis outage does not flood it (one line per 10 s per process).
    if (Date.now() - lastWarnAt < 10_000) return;
    lastWarnAt = Date.now();
    logger.warn({ err: err.message, op }, 'Cache unavailable, continuing without it');
  };

  return {
    async getJson(key) {
      if (!redis || open()) return null;
      try {
        const raw = await withTimeout(redis.get(key), CACHE.timeoutMs, 'cache get');
        return raw ? JSON.parse(raw) : null;
      } catch (err) {
        warn('get', err);
        return null;
      }
    },

    async setJson(key, value, ttlSeconds) {
      if (!redis || open()) return;
      try {
        await withTimeout(redis.set(key, JSON.stringify(value), 'EX', ttlSeconds), CACHE.timeoutMs);
      } catch (err) {
        warn('set', err);
      }
    },

    /** Deletes keys. Failure is tolerated: the TTL bounds how stale an entry can get. */
    async del(...keys) {
      if (!redis || keys.length === 0) return;
      try {
        await withTimeout(redis.del(...keys), CACHE.timeoutMs, 'cache del');
      } catch (err) {
        warn('del', err);
      }
    },
  };
}