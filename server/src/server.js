import { createApp } from './app.js';
import { parseEnv } from './config/env.js';
import { connectMongo, disconnectMongo, pingMongo } from './lib/db.js';
import { createEsClient, pingEs } from './lib/es.js';
import { createLogger } from './lib/logger.js';
import { createRedis, pingRedis } from './lib/redis.js';
import { createHealthService } from './modules/health/health.service.js';

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

async function main() {
  // Mongo is the source of truth, so it is required to boot. Redis and ES are not.
  await connectMongo({ uri: env.MONGODB_URI, logger });

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
  });
  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'API listening'));

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
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