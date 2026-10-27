import { createApp } from '../src/app.js';
import { createLogger } from '../src/lib/logger.js';
import { createHealthService } from '../src/modules/health/health.service.js';

export const silentLogger = createLogger({ level: 'silent', nodeEnv: 'test' });

export const ORIGIN = 'http://localhost:5173';

/** Real app, fake infrastructure. `checks` maps component name -> async function. */
export function buildTestApp({ checks, nodeEnv = 'test', healthService } = {}) {
  const service =
    healthService ??
    createHealthService({
      logger: silentLogger,
      timeoutMs: 100,
      checks: {
        mongo: { required: true, check: checks?.mongo ?? (async () => {}) },
        redis: { required: false, check: checks?.redis ?? (async () => {}) },
        elasticsearch: { required: false, check: checks?.elasticsearch ?? (async () => {}) },
      },
    });
  return createApp({
    nodeEnv,
    corsOrigins: [ORIGIN],
    logger: silentLogger,
    healthService: service,
  });
}