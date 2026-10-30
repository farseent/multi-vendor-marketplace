import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { API_PREFIX, JSON_BODY_LIMIT } from './config/constants.js';
import { createAuthenticate } from './middleware/auth.js';
import { createErrorHandler, notFound } from './middleware/error.js';
import { httpLogger } from './middleware/httpLogger.js';
import { requireAllowedOrigin } from './middleware/originCheck.js';
import { createLimiters } from './middleware/rateLimit.js';
import { authorize } from './middleware/rbac.js';
import { requestId } from './middleware/requestId.js';
import { createLoadShop } from './middleware/shop.js';
import { createAuditService } from './modules/audit/audit.service.js';
import { createAuthController } from './modules/auth/auth.controller.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createAuthService } from './modules/auth/auth.service.js';
import { createAccessTokenService } from './modules/auth/auth.tokens.js';
import { createCategoriesController } from './modules/catalog/categories.controller.js';
import { createCategoriesRouter } from './modules/catalog/categories.routes.js';
import { createCategoriesService } from './modules/catalog/categories.service.js';
import { createProductsController } from './modules/catalog/products.controller.js';
import { createProductsRouter } from './modules/catalog/products.routes.js';
import { createProductsService } from './modules/catalog/products.service.js';
import { createHealthRouter } from './modules/health/health.routes.js';
import { createShopsController } from './modules/shops/shops.controller.js';
import { createShopsRouter } from './modules/shops/shops.routes.js';
import { createShopsService } from './modules/shops/shops.service.js';
import { createUploadsController } from './modules/uploads/uploads.controller.js';
import { createUploadsRouter } from './modules/uploads/uploads.routes.js';
import { createUploadsService } from './modules/uploads/uploads.service.js';
import { createUsersController } from './modules/users/users.controller.js';
import { createUsersRouter } from './modules/users/users.routes.js';
import { createUsersService } from './modules/users/users.service.js';

/**
 * Builds the Express app from injected dependencies, so tests need no real Redis/ES.
 * `redis` is optional: without it the rate limiters use their in-memory counters.
 * `storage` is optional too ({ publicUrl, presignPut }, see lib/s3.js): without it image
 * uploads answer 503 and image URLs are null.
 */
export function createApp({
  nodeEnv,
  corsOrigins,
  logger,
  healthService,
  authConfig,
  redis = null,
  storage = null,
  trustProxy = 0,
}) {
  const app = express();
  app.set('trust proxy', trustProxy); // makes req.ip the real client IP behind a proxy

  app.use(requestId);
  app.use(httpLogger(logger));
  app.use(helmet());
  app.use(cors({ origin: corsOrigins, credentials: true, exposedHeaders: ['X-Request-Id'] }));
  // Phase 5: mount the raw-body webhook route BEFORE this line (signature needs the raw bytes).
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // Probes use /health; the same router is also under /api/v1 so the SPA client can reach it.
  // Mounted before the rate limiter and auth so health checks are never throttled.
  const health = createHealthRouter(healthService);
  app.use('/health', health);
  app.use(`${API_PREFIX}/health`, health);

  // --- Phase 1: auth + users ---
  const accessTokens = createAccessTokenService({
    secret: authConfig.jwtSecret,
    ttlSeconds: authConfig.accessTtlSeconds,
  });
  const authenticate = createAuthenticate(accessTokens);
  const limiters = createLimiters({ redis, logger });

  const authService = createAuthService({ accessTokens, config: authConfig });
  const usersService = createUsersService();

  // --- Phase 2: shops, catalog, uploads ---
  const audit = createAuditService();
  const shopsService = createShopsService({ audit, storage });
  const categoriesService = createCategoriesService({ audit });
  const productsService = createProductsService({ storage });
  const uploadsService = createUploadsService({ storage });
  const loadShop = createLoadShop(shopsService);

  // Module routers declare full paths relative to /api/v1 (no nesting). Keeping the list on the
  // app lets tests enumerate every registered route (see tests/helpers.js listApiRoutes).
  const routers = [
    createAuthRouter({
      controller: createAuthController({ authService, config: authConfig }),
      authenticate,
      limiters,
      originCheck: requireAllowedOrigin(corsOrigins),
    }),
    createUsersRouter({ controller: createUsersController({ usersService }), authenticate }),
    createShopsRouter({ controller: createShopsController({ shopsService }) }),
    createCategoriesRouter({ controller: createCategoriesController({ categoriesService }) }),
    createProductsRouter({ controller: createProductsController({ productsService }), loadShop }),
    createUploadsRouter({
      controller: createUploadsController({ uploadsService }),
      loadShop,
      limiters,
    }),
  ];
  app.set('apiRouters', routers);

  const api = express.Router();
  api.use(limiters.global);
  // Structural RBAC: everything under /vendor and /admin is role-gated here, before any module
  // router runs, so a route added later cannot forget the check. Shop approval and ownership are
  // enforced per route (loadShop + service queries scoped by vendorId).
  api.use('/vendor', authenticate, authorize('vendor'));
  api.use('/admin', authenticate, authorize('admin'));
  for (const router of routers) api.use(router);
  app.use(API_PREFIX, api);

  app.use(notFound);
  app.use(createErrorHandler({ nodeEnv, logger }));
  return app;
}
