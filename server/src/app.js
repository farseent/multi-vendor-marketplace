import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { API_PREFIX, JSON_BODY_LIMIT } from './config/constants.js';
import { createErrorHandler, notFound } from './middleware/error.js';
import { httpLogger } from './middleware/httpLogger.js';
import { requestId } from './middleware/requestId.js';
import { createHealthRouter } from './modules/health/health.routes.js';

/** Builds the Express app from injected dependencies, so tests need no real Mongo/Redis/ES. */
export function createApp({ nodeEnv, corsOrigins, logger, healthService }) {
  const app = express();

  app.use(requestId);
  app.use(httpLogger(logger));
  app.use(helmet());
  app.use(cors({ origin: corsOrigins, credentials: true, exposedHeaders: ['X-Request-Id'] }));
  // Phase 5: mount the raw-body webhook route BEFORE this line (signature needs the raw bytes).
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // Probes use /health; the same router is also under /api/v1 so the SPA client can reach it.
  const health = createHealthRouter(healthService);
  app.use('/health', health);
  app.use(`${API_PREFIX}/health`, health);

  app.use(notFound);
  app.use(createErrorHandler({ nodeEnv, logger }));
  return app;
}