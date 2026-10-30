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
  presign: { windowMs: 60 * 60_000, max: 30 }, // per vendor user (Phase 2)
};

// Vendors, catalog, uploads (Phase 2)
export const MAX_COMMISSION_BPS = 5000;
export const MAX_PRODUCT_IMAGES = 6;
export const MAX_PRODUCT_ATTRIBUTES = 10;
export const MAX_STOCK_QTY = 1_000_000;
export const MIN_PRICE_PAISE = 100;
// Key prefix for every vendor-owned image (products and shop logos): products/{vendorId}/...
// The bucket allows public read only under products/* (ARCHITECTURE 3.7).
export const UPLOAD_KEY_PREFIX = 'products';
export const UPLOAD = {
  // allowed content type -> file extension
  types: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
  maxBytes: 5 * 1024 * 1024,
  urlTtlSeconds: 300,
};

export const VENDOR_STATUSES = ['pending', 'approved', 'rejected', 'suspended'];
// What an admin may move a shop to: from -> allowed targets. Anything else is a 409.
export const VENDOR_TRANSITIONS = {
  pending: ['approved', 'rejected'],
  approved: ['suspended'],
  suspended: ['approved'],
  rejected: ['approved'],
};
export const PRODUCT_STATUSES = ['draft', 'active', 'archived', 'suspended'];
