import { createApp } from '../src/app.js';
import { createLogger } from '../src/lib/logger.js';
import { createHealthService } from '../src/modules/health/health.service.js';

export const silentLogger = createLogger({ level: 'silent', nodeEnv: 'test' });

export const ORIGIN = 'http://localhost:5173';

// bcrypt cost 4 keeps the suite fast; the cost-12 guarantee is tested in password.test.js.
export const TEST_AUTH_CONFIG = Object.freeze({
  jwtSecret: 'test-secret-test-secret-test-secret-123',
  accessTtlSeconds: 900,
  refreshTtlDays: 30,
  bcryptCost: 4,
  cookie: { sameSite: 'lax', secure: false },
});

/** In-memory stand-in for lib/s3.js: no AWS, but the same two functions. */
export const fakeStorage = Object.freeze({
  publicUrl: (key) => `https://cdn.test/${key}`,
  presignPut: async ({ key, contentType, sizeBytes, expiresIn }) =>
    `https://s3.test/${key}?ct=${encodeURIComponent(contentType)}&len=${sizeBytes}&exp=${expiresIn}`,
});

/** Real app, fake infrastructure. `checks` maps component name -> async function. */
export function buildTestApp({
  checks,
  nodeEnv = 'test',
  healthService,
  logger = silentLogger,
  authConfig = TEST_AUTH_CONFIG,
  redis = null,
  storage = fakeStorage,
} = {}) {
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
    logger,
    healthService: service,
    authConfig,
    redis,
    storage,
  });
}

/**
 * Every route registered by the module routers, as { method, path } with the /api/v1 prefix.
 * (Express 5 does not store mount paths, so app.js exposes the router list via app.set.)
 */
export function listApiRoutes(app) {
  const routes = [];
  for (const router of app.get('apiRouters')) {
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({ method: method.toUpperCase(), path: `/api/v1${layer.route.path}` });
      }
    }
  }
  return routes;
}
