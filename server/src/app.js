import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { API_PREFIX, JSON_BODY_LIMIT, WEBHOOK_BODY_LIMIT } from './config/constants.js';
import { createAuthenticate } from './middleware/auth.js';
import { createErrorHandler, notFound } from './middleware/error.js';
import { httpLogger } from './middleware/httpLogger.js';
import { requireAllowedOrigin } from './middleware/originCheck.js';
import { createLimiters } from './middleware/rateLimit.js';
import { authorize } from './middleware/rbac.js';
import { requestId } from './middleware/requestId.js';
import { createLoadShop } from './middleware/shop.js';
import { createCache } from './lib/cache.js';
import { createJobLocks } from './jobs/jobLock.js';
import { createAuditService } from './modules/audit/audit.service.js';
import { createAuthController } from './modules/auth/auth.controller.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createAuthService } from './modules/auth/auth.service.js';
import { createAccessTokenService } from './modules/auth/auth.tokens.js';
import { createCartController } from './modules/cart/cart.controller.js';
import { createCartRouter } from './modules/cart/cart.routes.js';
import { createCartService } from './modules/cart/cart.service.js';
import { createCategoriesController } from './modules/catalog/categories.controller.js';
import { createCategoriesRouter } from './modules/catalog/categories.routes.js';
import { createCategoriesService } from './modules/catalog/categories.service.js';
import { createProductsController } from './modules/catalog/products.controller.js';
import { createProductsRouter } from './modules/catalog/products.routes.js';
import { createProductsService } from './modules/catalog/products.service.js';
import { createCouponsController } from './modules/coupons/coupons.controller.js';
import { createCouponsRouter } from './modules/coupons/coupons.routes.js';
import { createCouponsService } from './modules/coupons/coupons.service.js';
import { createHealthRouter } from './modules/health/health.routes.js';
import { createInvoicesController } from './modules/invoices/invoices.controller.js';
import { createInvoicesRouter } from './modules/invoices/invoices.routes.js';
import { createInvoicesService } from './modules/invoices/invoices.service.js';
import { createCheckoutService } from './modules/orders/checkout.service.js';
import { createOrdersController } from './modules/orders/orders.controller.js';
import { createFulfillmentController } from './modules/orders/fulfillment.controller.js';
import { createFulfillmentRouter } from './modules/orders/fulfillment.routes.js';
import { createFulfillmentService } from './modules/orders/fulfillment.service.js';
import { createRefundsController } from './modules/refunds/refunds.controller.js';
import { createRefundsRouter } from './modules/refunds/refunds.routes.js';
import { createRefundsService } from './modules/refunds/refunds.service.js';
import { createReviewsController } from './modules/reviews/reviews.controller.js';
import { createReviewsRouter } from './modules/reviews/reviews.routes.js';
import { createReviewsService } from './modules/reviews/reviews.service.js';
import { createReconciliationService } from './modules/settlements/reconciliation.service.js';
import { createSettlementsController } from './modules/settlements/settlements.controller.js';
import { createSettlementsRouter } from './modules/settlements/settlements.routes.js';
import { createSettlementsService } from './modules/settlements/settlements.service.js';
import { createOrderLifecycle } from './modules/orders/orders.lifecycle.js';
import { createPaymentsController } from './modules/payments/payments.controller.js';
import { createPaymentsRouter } from './modules/payments/payments.routes.js';
import { createPaymentsService } from './modules/payments/payments.service.js';
import { createWebhooksService } from './modules/payments/webhooks.service.js';
import { createOrdersRouter } from './modules/orders/orders.routes.js';
import { createOrdersService } from './modules/orders/orders.service.js';
import { assertPaymentProvider } from './providers/payment/PaymentProvider.js';
import {
  createSearchAdminController,
  createSearchController,
} from './modules/search/search.controller.js';
import { createSearchOutbox } from './modules/search/search.outbox.js';
import { createReindexer } from './modules/search/search.reindex.js';
import { createSearchRouter } from './modules/search/search.routes.js';
import { createSearchService } from './modules/search/search.service.js';
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
 * `searchIndex` is optional too (see modules/search/search.index.js): without it search answers
 * from the Mongo fallback and the reindex endpoint answers 503.
 * `paymentProvider` is required (see providers/payment/PaymentProvider.js): the Razorpay adapter or
 * the MockLedger. `platformCommissionBps` is the D6/D51 default rate.
 */
export function createApp({
  nodeEnv,
  corsOrigins,
  logger,
  healthService,
  authConfig,
  redis = null,
  storage = null,
  searchIndex = null,
  paymentProvider,
  platformCommissionBps = 1000,
  trustProxy = 0,
}) {
  assertPaymentProvider(paymentProvider);
  const app = express();
  app.set('trust proxy', trustProxy); // makes req.ip the real client IP behind a proxy

  app.use(requestId);
  app.use(httpLogger(logger));
  app.use(helmet());
  app.use(
    cors({
      origin: corsOrigins,
      credentials: true,
      exposedHeaders: ['X-Request-Id', 'X-Search-Fallback', 'Content-Disposition'],
    }),
  );
  // Webhooks need the RAW bytes for the signature, so their router (with its own raw-body parser)
  // is mounted before the JSON parser. Routes are added to it below, once the services exist.
  // Not rate limited and not behind auth: the signature is the authentication (D46).
  const webhookRouter = express.Router();
  webhookRouter.use(express.raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT }));
  app.use(`${API_PREFIX}/webhooks`, webhookRouter);
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
  // --- Phase 3: search + caching ---
  const cache = createCache({ redis, logger });
  const searchOutbox = createSearchOutbox();
  const searchService = createSearchService({ searchIndex, cache, storage, logger });
  const reindexer = createReindexer({ searchIndex, jobLocks: createJobLocks(), logger });

  const shopsService = createShopsService({ audit, storage, searchOutbox, cache });
  const categoriesService = createCategoriesService({ audit, cache });
  const productsService = createProductsService({ storage, searchOutbox, cache });
  const uploadsService = createUploadsService({ storage });
  const loadShop = createLoadShop(shopsService);

  // --- Phase 4: cart + coupons ---
  const couponsService = createCouponsService({ audit });
  const cartService = createCartService({ couponsService, storage });

  // --- Phase 5: checkout, orders, payments ---
  const lifecycle = createOrderLifecycle({ searchOutbox, cache, logger });
  const checkoutService = createCheckoutService({
    paymentProvider,
    platformCommissionBps,
    lifecycle,
    searchOutbox,
    logger,
  });
  const ordersService = createOrdersService({ paymentProvider, storage });
  const paymentsService = createPaymentsService({
    paymentProvider,
    lifecycle,
    searchOutbox,
    logger,
    nodeEnv,
  });
  // --- Phase 6: fulfilment, refunds, settlements, reconciliation ---
  const jobLocks = createJobLocks();
  const refundsService = createRefundsService({ paymentProvider, audit, logger });
  const fulfillmentService = createFulfillmentService({
    lifecycle,
    refundsService,
    audit,
    logger,
  });
  const settlementsService = createSettlementsService({ paymentProvider, audit, logger });
  const reconciliationService = createReconciliationService({
    paymentProvider,
    jobLocks,
    audit,
    logger,
  });
  const webhooksService = createWebhooksService({
    provider: paymentProvider.name === 'mock' ? 'razorpay' : paymentProvider.name,
    paymentProvider,
    paymentsService,
    refundsService,
    settlementsService,
    logger,
  });
  const paymentsController = createPaymentsController({
    paymentsService,
    webhooksService,
    paymentProvider,
  });
  webhookRouter.post('/razorpay', paymentsController.razorpayWebhook);
  // --- Phase 7: reviews and invoices ---
  const reviewsService = createReviewsService({ audit, cache, searchOutbox });
  const invoicesService = createInvoicesService();
  app.set('phase7Services', { reviewsService, invoicesService });

  // The background jobs (server.js) use the same service instances as the HTTP handlers.
  app.set('paymentServices', { lifecycle, paymentsService });
  app.set('phase6Services', {
    refundsService,
    settlementsService,
    reconciliationService,
    jobLocks,
  });

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
    createProductsRouter({
      controller: createProductsController({ productsService }),
      searchController: createSearchController({ searchService }),
      loadShop,
      limiters,
    }),
    createSearchRouter({ adminController: createSearchAdminController({ reindexer, audit }) }),
    createUploadsRouter({
      controller: createUploadsController({ uploadsService }),
      loadShop,
      limiters,
    }),
    createCartRouter({ controller: createCartController({ cartService }), authenticate }),
    createCouponsRouter({
      controller: createCouponsController({ couponsService }),
      loadShop,
    }),
    createOrdersRouter({
      controller: createOrdersController({ checkoutService, ordersService }),
      authenticate,
      limiters,
    }),
    createPaymentsRouter({ controller: paymentsController, authenticate }),
    createFulfillmentRouter({
      controller: createFulfillmentController({ fulfillmentService, ordersService }),
      authenticate,
      loadShop,
    }),
    createRefundsRouter({
      controller: createRefundsController({ refundsService, fulfillmentService }),
    }),
    createSettlementsRouter({
      controller: createSettlementsController({ settlementsService, reconciliationService }),
      loadShop,
    }),
    createReviewsRouter({
      controller: createReviewsController({ reviewsService }),
      authenticate,
    }),
    createInvoicesRouter({
      controller: createInvoicesController({ invoicesService }),
      authenticate,
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
