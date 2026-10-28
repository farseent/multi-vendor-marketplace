import { ACCESS_TOKEN_TTL_SECONDS } from './constants.js';

/** Turns the validated env into the one object the auth code needs. */
export function buildAuthConfig(env) {
  return Object.freeze({
    jwtSecret: env.JWT_ACCESS_SECRET,
    accessTtlSeconds: ACCESS_TOKEN_TTL_SECONDS,
    refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    bcryptCost: env.BCRYPT_COST,
    cookie: {
      sameSite: env.COOKIE_SAME_SITE,
      // SameSite=None is rejected by browsers unless Secure is set.
      secure: env.NODE_ENV === 'production' || env.COOKIE_SAME_SITE === 'none',
    },
  });
}
