import { AppError } from '../lib/AppError.js';

/**
 * CSRF defence for cookie-authenticated routes (/auth/refresh, /auth/logout).
 * A browser always sends Origin on cross-site POSTs; if it is present it must be allowlisted.
 * Requests with no Origin (curl, server-to-server, tests) are not browser-driven CSRF.
 */
export function requireAllowedOrigin(allowedOrigins) {
  return (req, _res, next) => {
    const origin = req.get('origin');
    if (origin && !allowedOrigins.includes(origin)) {
      return next(new AppError('FORBIDDEN', 403, 'Origin not allowed'));
    }
    next();
  };
}
