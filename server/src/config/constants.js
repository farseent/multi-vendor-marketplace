export const API_PREFIX = '/api/v1';
export const JSON_BODY_LIMIT = '100kb';
export const HEALTH_CHECK_TIMEOUT_MS = 1500;

// Auth (Phase 1)
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_COOKIE_NAME = 'refreshToken';
// Scoped to the auth routes so the browser never sends the refresh token anywhere else.
export const REFRESH_COOKIE_PATH = `${API_PREFIX}/auth`;
export const MAX_ADDRESSES = 5;

// Fixed-window limits (ARCHITECTURE section 8).
export const RATE_LIMITS = {
  global: { windowMs: 15 * 60_000, max: 300 }, // per IP
  login: { windowMs: 15 * 60_000, max: 10 }, // per IP + email
  register: { windowMs: 60 * 60_000, max: 5 }, // per IP, shared by both register routes
  changePassword: { windowMs: 15 * 60_000, max: 10 }, // per user
};
