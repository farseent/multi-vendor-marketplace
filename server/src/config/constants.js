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
  search: { windowMs: 60_000, max: 60 }, // per IP (Phase 3)
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

// Search and caching (Phase 3)
export const SEARCH = {
  alias: 'products', // the app only ever talks to this alias; reindex swaps what it points at
  maxResultWindow: 10_000, // Elasticsearch default index.max_result_window (page * limit)
  maxQueryLength: 100,
  // 0 replicas keeps a single-node cluster green. Raise it on a multi-node cluster.
  replicas: 0,
  reindexBatchSize: 500,
};
export const SEARCH_SORTS = ['relevance', 'price', '-price', '-createdAt', '-ratingAvg'];

// Outbox -> Elasticsearch sync job (ARCHITECTURE 3.6)
export const SEARCH_SYNC = {
  jobName: 'searchSync',
  intervalMs: 2000,
  batchSize: 100,
  leaseMs: 30_000,
  maxAttempts: 10, // per-entry failures beyond this are flagged and left for an admin
  maxBackoffMs: 5 * 60_000,
  outageBackoffMs: { min: 2000, max: 60_000 }, // whole-request failures (ES unreachable)
};

// Redis cache (ARCHITECTURE 4). Keys are namespaced `cache:*`; every call is fail-open.
export const CACHE = {
  timeoutMs: 100,
  breakerMs: 5000, // skip reads/writes this long after a Redis failure
  keys: {
    product: (slug) => `cache:product:${slug}`,
    categories: 'cache:categories',
    search: (hash) => `cache:search:${hash}`,
  },
  ttlSeconds: { product: 5 * 60, categories: 60 * 60, search: 60 },
};

// Cart and coupons (Phase 4)
export const CART = {
  maxItems: 30, // distinct products per cart (DATABASE_SCHEMA carts)
  maxQuantity: 10, // per product
};
export const COUPON = {
  maxPercent: 90,
  minFixedPaise: 100,
  statuses: ['active', 'disabled'],
  scopes: ['platform', 'vendor'],
  types: ['percent', 'fixed'],
};
// Why a coupon was refused. Sent to the client as COUPON_INVALID details.reason.
export const COUPON_REASONS = [
  'not_found',
  'disabled',
  'not_started',
  'expired',
  'empty_cart',
  'wrong_vendor',
  'below_min_order',
  'total_limit_reached',
  'user_limit_reached',
];
