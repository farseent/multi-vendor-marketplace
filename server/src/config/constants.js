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
  checkout: { windowMs: 60_000, max: 10 }, // per customer (Phase 5, ARCHITECTURE 8)
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

// Checkout, orders, payments (Phase 5)
export const DEFAULT_PLATFORM_COMMISSION_BPS = 1000; // D6 / D51: 10%
export const RESERVATION_MINUTES = 15; // D7: stock and coupon are held this long
export const MIN_TOTAL_PAISE = 100; // D50: the provider's INR 1.00 minimum order amount
export const MIN_TRANSFER_PAISE = 100; // D47a: smallest vendor payout we will send
export const ORDER_STATUSES = ['pending_payment', 'placed', 'completed', 'cancelled', 'expired'];
export const PAYMENT_STATUSES = ['unpaid', 'paid', 'failed'];
export const REFUND_STATUSES = ['none', 'partial', 'full'];
export const FULFILLMENT_STATUSES = [
  'pending_payment',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
];
export const IDEMPOTENCY_KEY = { min: 8, max: 100, pattern: /^[A-Za-z0-9_.:-]+$/ };
// A webhook event row in status `received` older than this is considered abandoned (D46).
export const WEBHOOK_STALE_CLAIM_MS = 60_000;
export const WEBHOOK_BODY_LIMIT = '256kb';

// Background jobs (D17: in-process, Mongo lease). ARCHITECTURE 5.
export const RESERVATION_JOB = {
  jobName: 'reservationRelease',
  intervalMs: 60_000,
  leaseMs: 55_000,
  batchSize: 100,
};
export const RECONCILE_JOB = {
  jobName: 'reconcilePending',
  intervalMs: 60_000,
  leaseMs: 55_000,
  batchSize: 50,
  minAgeMs: 5 * 60_000, // ARCHITECTURE 3.1: pending_payment orders older than 5 min
};

// Fulfilment, refunds, settlements (Phase 6)
export const RETURN_WINDOW_DAYS = 7; // D10: a delivered sub-order is refundable and unpaid for this long
// from -> to -> who may make that move. Anything not listed is 409 INVALID_STATE_TRANSITION
// (API_CONTRACTS section 3). `system` moves are made by payment confirmation, never by an API caller.
export const SUB_ORDER_TRANSITIONS = {
  pending_payment: { processing: ['system'] },
  processing: { shipped: ['vendor'], cancelled: ['vendor', 'customer'] },
  shipped: { delivered: ['vendor'] },
  delivered: {},
  cancelled: {},
};
export const REFUND_REASONS = ['customer_cancel', 'vendor_cancel', 'admin', 'failed_late_capture'];
export const MIN_REVERSAL_PAISE = 100; // Razorpay: a transfer reversal is at least INR 1.00 (D57)
export const REFUND_CLAIM_MS = 60_000; // one caller at a time may ask the provider (D54)
export const REFUND_RETRY_AFTER_MS = 5 * 60_000; // the reconcile job retries a refund after this long
export const SETTLEMENT_STATUSES = [
  'not_eligible',
  'pending_release',
  'released',
  'settled',
  'reversed',
  'failed',
];
// Settlement state machine (ARCHITECTURE 3.5): from -> allowed targets.
export const SETTLEMENT_TRANSITIONS = {
  not_eligible: ['pending_release', 'reversed'],
  pending_release: ['released', 'reversed', 'failed'],
  released: ['settled', 'failed'],
  settled: [],
  reversed: [],
  failed: [],
};
export const SETTLEMENT_JOB = {
  jobName: 'settlementRelease',
  intervalMs: 60 * 60_000, // hourly (ARCHITECTURE 3.5)
  leaseMs: 10 * 60_000,
  batchSize: 50,
  settleCheckAfterMs: 60 * 60_000, // released settlements are looked at after this long
};
export const RECONCILIATION_JOB = {
  jobName: 'reconciliation',
  intervalMs: 60 * 60_000, // wakes hourly, runs when the last report is older than minGapMs
  minGapMs: 23 * 60 * 60_000, // so a restart does not skip a day, and does not repeat one
  leaseMs: 30 * 60_000,
  maxSettlements: 1000, // checked per run; the report says when it was cut short
  maxStoredMismatches: 200,
  stuckRefundAfterMs: 60 * 60_000,
};

// Reviews and invoices (Phase 7)
export const REVIEW_STATUSES = ['published', 'hidden'];
export const REVIEW = {
  editWindowDays: 30, // API_CONTRACTS: edit/delete within 30 days of posting
  titleMax: 100,
  bodyMin: 10,
  bodyMax: 2000,
  sorts: ['-createdAt', 'createdAt', '-rating', 'rating'],
};
export const INVOICE = {
  // The seller named on the PDF. Not a tax identity: invoices are not GST-compliant (D19).
  platformName: 'Marketplace',
  numberPrefix: 'INV',
};
