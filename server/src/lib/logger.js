import pino from 'pino';

// Secrets never reach logs. Wildcards cover one nesting level (e.g. `body.password`).
const REDACT_PATHS = [
  'authorization',
  'cookie',
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  '*.password',
  '*.passwordHash',
  '*.currentPassword',
  '*.newPassword',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

/** `stream` is optional and only used by tests to capture output. */
export function createLogger({ level, nodeEnv }, stream) {
  return pino(
    {
      level,
      redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
      ...(nodeEnv === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
    },
    stream,
  );
}
