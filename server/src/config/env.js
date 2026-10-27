import { z } from 'zod';

const uri = (protocols, hint) =>
  z.string().regex(new RegExp(`^(${protocols.join('|')})://\\S+$`), `must be a ${hint}`);

// CORS origins are exact matches: scheme + host (+ port), no path or trailing slash.
const origins = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )
  .pipe(
    z
      .array(
        z.string().regex(/^https?:\/\/[^/\s]+$/, 'each origin must look like https://host[:port]'),
      )
      .min(1, 'at least one origin is required'),
  );

// Every variable the Phase 0 backend needs. Later phases add their own (JWT, S3, Razorpay...).
// NODE_ENV has no default on purpose: a production host that forgets it must fail, not
// silently run in development mode.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MONGODB_URI: uri(['mongodb', 'mongodb\\+srv'], 'mongodb:// or mongodb+srv:// URI'),
  REDIS_URL: uri(['redis', 'rediss'], 'redis:// or rediss:// URL'),
  ELASTICSEARCH_URL: uri(['http', 'https'], 'http(s):// URL'),
  CORS_ORIGINS: origins,
});

/**
 * Validate an env-like object and return typed, frozen config.
 * Throws with a readable list of problems. Error text never includes the values,
 * because they may contain credentials.
 */
export function parseEnv(source) {
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return Object.freeze(result.data);
}