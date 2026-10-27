import Redis from 'ioredis';

// Redis is cache-only and fail-open (D13), so a dead Redis must never crash the process
// or hang a request: the error listener prevents unhandled 'error' events, and
// maxRetriesPerRequest makes commands fail fast while disconnected.
export function createRedis({ url, logger }) {
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  });
  client.on('error', (err) => logger.warn({ err: err.message }, 'Redis error'));
  return client;
}

export async function pingRedis(client) {
  await client.ping();
}