import { createApp } from './app.js';
import { buildAuthConfig } from './config/auth.js';
import { parseEnv } from './config/env.js';
import { connectMongo, disconnectMongo, pingMongo } from './lib/db.js';
import { createEsClient, pingEs } from './lib/es.js';
import { createJobLocks, JobLock } from './jobs/jobLock.js';
import { createReconciliationJob } from './jobs/reconciliation.js';
import { createSettlementReleaseJob } from './jobs/settlementRelease.js';
import { ReconciliationReport } from './modules/settlements/reconciliation.model.js';
import { createReconcilePendingJob } from './jobs/reconcilePending.js';
import { createReservationReleaseJob } from './jobs/reservationRelease.js';
import { createSearchSyncJob } from './jobs/searchSync.js';
import { createLogger } from './lib/logger.js';
import { createRedis, pingRedis } from './lib/redis.js';
import { createStorage } from './lib/s3.js';
import { RefreshToken } from './modules/auth/auth.model.js';
import { AuditLog } from './modules/audit/audit.model.js';
import { Category } from './modules/catalog/categories.model.js';
import { Cart } from './modules/cart/cart.model.js';
import { Product } from './modules/catalog/products.model.js';
import { Coupon } from './modules/coupons/coupons.model.js';
import { CouponRedemption } from './modules/coupons/redemptions.model.js';
import { Counter, Order, SubOrder } from './modules/orders/orders.model.js';
import { Payment, WebhookEvent } from './modules/payments/payments.model.js';
import { Invoice } from './modules/invoices/invoices.model.js';
import { Refund } from './modules/refunds/refunds.model.js';
import { Review } from './modules/reviews/reviews.model.js';
import { Settlement } from './modules/settlements/settlements.model.js';
import { createPaymentProvider } from './providers/payment/index.js';
import { createHealthService } from './modules/health/health.service.js';
import { createSearchIndex } from './modules/search/search.index.js';
import { SearchOutbox } from './modules/search/search.model.js';
import { Vendor } from './modules/shops/shops.model.js';
import { User } from './modules/users/users.model.js';

// Fail fast: a misconfigured instance must not start (exit code 1).
let env;
try {
  env = parseEnv(process.env);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const logger = createLogger({ level: env.LOG_LEVEL, nodeEnv: env.NODE_ENV });
const redis = createRedis({ url: env.REDIS_URL, logger });
const es = createEsClient({ url: env.ELASTICSEARCH_URL });
// Image storage is optional: without S3_BUCKET the API still runs, uploads answer 503.
const storage = env.S3_BUCKET
  ? createStorage({
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      publicBaseUrl: env.S3_PUBLIC_BASE_URL,
    })
  : null;
if (!storage) logger.warn('S3_BUCKET is not set: image uploads are disabled');

async function main() {
  // Mongo is the source of truth, so it is required to boot. Redis and ES are not.
  await connectMongo({ uri: env.MONGODB_URI, logger });
  // Unique indexes (email, tokenHash, shopSlug, product slug/sku...) must exist before we accept traffic.
  await Promise.all([
    User.init(),
    RefreshToken.init(),
    Vendor.init(),
    Category.init(),
    Product.init(),
    AuditLog.init(),
    SearchOutbox.init(),
    JobLock.init(),
    // Phase 5: the unique indexes carry the idempotency guarantees (order key, webhook event id,
    // provider ids), so they must exist before the first checkout or webhook arrives.
    Cart.init(),
    Coupon.init(),
    CouponRedemption.init(),
    Order.init(),
    SubOrder.init(),
    Counter.init(),
    Payment.init(),
    WebhookEvent.init(),
    Settlement.init(),
    Refund.init(),
    ReconciliationReport.init(),
    // Phase 7: one review per customer and product, one invoice per order, unique numbers.
    Review.init(),
    Invoice.init(),
  ]);

  // Elasticsearch is optional at boot (D12): if it is down, search uses the Mongo fallback and
  // the sync job creates the index as soon as ES answers.
  const searchIndex = createSearchIndex({ client: es });
  await searchIndex
    .ensureIndex()
    .catch((err) => logger.warn({ err: err.message }, 'Elasticsearch not ready at boot'));

  const paymentProvider = createPaymentProvider(env);
  logger.info({ provider: paymentProvider.name }, 'Payment provider ready');

  const healthService = createHealthService({
    logger,
    checks: {
      mongo: { required: true, check: pingMongo },
      redis: { required: false, check: () => pingRedis(redis) },
      elasticsearch: { required: false, check: () => pingEs(es) },
    },
  });

  const app = createApp({
    nodeEnv: env.NODE_ENV,
    corsOrigins: env.CORS_ORIGINS,
    logger,
    healthService,
    authConfig: buildAuthConfig(env),
    redis,
    storage,
    searchIndex,
    paymentProvider,
    platformCommissionBps: env.PLATFORM_COMMISSION_BPS,
    trustProxy: env.TRUST_PROXY,
  });
  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'API listening'));

  const searchSync = createSearchSyncJob({ searchIndex, jobLocks: createJobLocks(), logger });
  searchSync.start();

  // Phase 5 jobs share the HTTP handlers' service instances and are lease-guarded (D17).
  const paymentServices = app.get('paymentServices');
  const { refundsService, settlementsService, reconciliationService } = app.get('phase6Services');
  const jobs = [
    searchSync,
    createReservationReleaseJob({ ...paymentServices, jobLocks: createJobLocks(), logger }),
    createReconcilePendingJob({
      ...paymentServices,
      refundsService,
      jobLocks: createJobLocks(),
      logger,
    }),
    // Phase 6: hourly settlement release and the daily reconciliation (lease-guarded, D17).
    createSettlementReleaseJob({ settlementsService, jobLocks: createJobLocks(), logger }),
    createReconciliationJob({ reconciliationService, jobLocks: createJobLocks(), logger }),
  ];
  jobs.slice(1).forEach((job) => job.start());

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    jobs.forEach((job) => job.stop());
    logger.info({ signal }, 'Shutting down');
    setTimeout(() => process.exit(1), 10_000).unref();
    server.close(async () => {
      await Promise.allSettled([disconnectMongo(), redis.disconnect(), es.close()]);
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => {
  logger.fatal({ err }, 'Unhandled promise rejection');
  process.exit(1);
});

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
