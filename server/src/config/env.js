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

// An empty value in .env ("S3_BUCKET=") counts as "not set".
const optionalText = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

// Every variable the backend needs. Later phases add their own (S3, Razorpay...).
// NODE_ENV has no default on purpose: a production host that forgets it must fail, not
// silently run in development mode.
const fields = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MONGODB_URI: uri(['mongodb', 'mongodb\\+srv'], 'mongodb:// or mongodb+srv:// URI'),
  REDIS_URL: uri(['redis', 'rediss'], 'redis:// or rediss:// URL'),
  ELASTICSEARCH_URL: uri(['http', 'https'], 'http(s):// URL'),
  CORS_ORIGINS: origins,

  // --- Phase 1: auth ---
  // HS256 signing key for access tokens. Generate: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  // Cost 12 is the project minimum (acceptance criteria); the env cannot lower it.
  BCRYPT_COST: z.coerce.number().int().min(12).max(15).default(12),
  // 'lax' for same parent domain; 'none' (forces Secure) for cross-site frontends (V5).
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  // Number of reverse proxies in front of the API (0 = none). Needed for correct client IPs
  // in IP-based rate limits behind Render/Railway/nginx etc.
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),

  // --- Phase 2: image uploads (S3) ---
  // Optional at boot so the API runs without AWS; upload endpoints answer 503 until configured.
  // Credentials come from the standard AWS variables (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY),
  // read by the AWS SDK itself, never by our code and never sent to the frontend.
  S3_BUCKET: optionalText,
  S3_REGION: optionalText,
  // Base URL images are served from (e.g. a CDN). Defaults to the bucket's own S3 URL.
  S3_PUBLIC_BASE_URL: optionalText.pipe(
    z
      .string()
      .regex(/^https?:\/\/\S+$/, 'must be an http(s):// URL')
      .optional(),
  ),
});

// Cross-field rule: a bucket without a region cannot sign anything.
const schema = fields.refine((env) => !env.S3_BUCKET || env.S3_REGION, {
  path: ['S3_REGION'],
  message: 'is required when S3_BUCKET is set',
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
