import { HEALTH_CHECK_TIMEOUT_MS } from '../../config/constants.js';
import { withTimeout } from '../../lib/timeout.js';

/**
 * checks: { [name]: { required: boolean, check: () => Promise<void> } }
 * Mongo is required; Redis and Elasticsearch are reported as degraded, not fatal (ARCHITECTURE §8).
 */
export function createHealthService({ checks, logger, timeoutMs = HEALTH_CHECK_TIMEOUT_MS }) {
  async function runCheck(name, { required, check }) {
    const started = performance.now();
    try {
      await withTimeout(check(), timeoutMs, name);
      return [name, { status: 'up', required, latencyMs: Math.round(performance.now() - started) }];
    } catch (err) {
      // The reason goes to logs only: this endpoint is public and error text can contain hostnames.
      logger.warn({ component: name, err: err.message }, 'Health check failed');
      return [name, { status: 'down', required }];
    }
  }

  return {
    liveness() {
      return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
    },

    async readiness() {
      const entries = await Promise.all(Object.entries(checks).map(([n, c]) => runCheck(n, c)));
      const requiredDown = entries.some(([, c]) => c.required && c.status === 'down');
      const anyDown = entries.some(([, c]) => c.status === 'down');
      return {
        ready: !requiredDown,
        status: requiredDown ? 'unavailable' : anyDown ? 'degraded' : 'ok',
        components: Object.fromEntries(entries),
      };
    },
  };
}