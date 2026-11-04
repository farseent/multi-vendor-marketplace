import { apiFetch } from './api.js';
import { formatINR, rupeesToPaise } from './money.js';

// Admin console helpers (Phase 8). The API authorizes every request; nothing here is a security
// check. These functions build requests, turn form text into the API's integer-paise bodies,
// and decide which buttons to SHOW.

/** { a: 1, b: '', c: undefined } -> "?a=1". Empty values are left out. */
export function qs(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

/** GET /admin/<path>: resolves to { items, meta } for lists. */
export async function adminList(path, params) {
  const { data, meta } = await apiFetch(`/admin/${path}${qs(params)}`);
  return { items: data, meta };
}

/** GET /admin/<path> for one object (an order, an analytics figure). */
export const adminGet = async (path, params) =>
  (await apiFetch(`/admin/${path}${qs(params)}`)).data;

/** PATCH/POST /admin/<path>. Resolves to the response data. */
export const adminSend = async (path, method, body, headers) =>
  (await apiFetch(`/admin/${path}`, { method, body, headers })).data;

export const adminKey = (resource, params) => ['admin', resource, params ?? {}];
export const ADMIN_ROOT_KEY = ['admin'];

// ---- messages ----

const REASONS = {
  exceeds_refundable: 'That is more than the customer paid for this sub-order.',
  return_window_closed: 'The 7-day return window for this sub-order has ended.',
  not_refundable: 'This sub-order cannot be refunded (not paid, or cancelled).',
  refund_below_minimum:
    'The vendor share of this refund is below ₹1.00, which the payment provider does not allow. Refund a different amount.',
  idempotency_key_reused:
    'This refund request was already used for a different amount. Reload the page.',
  open_refund: 'A refund is still open on this settlement.',
  nothing_to_release: 'There is nothing to release for this settlement.',
  payout_account_inactive: "The vendor's payout account is not active.",
  no_provider_transfer: 'There is no provider transfer to release.',
  changed_meanwhile: 'The settlement changed while you were releasing it. Reload and try again.',
  run_in_progress: 'A reconciliation run is already in progress.',
};

export function adminErrorMessage(error) {
  const reason = error?.details?.reason;
  if (reason && REASONS[reason]) return REASONS[reason];
  if (error?.code === 'INVALID_STATE_TRANSITION') {
    return 'That change is not allowed from the current status. Reload the page: someone may have changed it.';
  }
  if (error?.code === 'PAYMENT_PROVIDER_ERROR') {
    return 'The payment provider refused or could not be reached. Nothing was changed; try again shortly.';
  }
  if (error?.status === 422 && Array.isArray(error.details) && error.details.length) {
    return error.details.map((d) => d.message).join(' ');
  }
  return error?.message ?? 'Something went wrong.';
}

// ---- vendors ----

/** What an admin may move a shop to (the same table as the API, VENDOR_TRANSITIONS). */
const VENDOR_NEXT = {
  pending: ['approved', 'rejected'],
  approved: ['suspended'],
  suspended: ['approved'],
  rejected: ['approved'],
};
export const vendorNextStatuses = (status) => VENDOR_NEXT[status] ?? [];

/** "12.5" -> 1250 basis points; "" -> null (use the default rate); anything else -> undefined. */
export function percentToBps(text) {
  const value = String(text ?? '').trim();
  if (value === '') return null;
  const match = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return undefined;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bps <= 5000 ? bps : undefined;
}
export const bpsToPercent = (bps) => (bps === null || bps === undefined ? '' : String(bps / 100));

// ---- refunds ----

/**
 * The form's amount (rupees, empty = everything still refundable) and note -> an API body, or an
 * error message. `refundablePaise` only gives a friendlier message than the server's 409.
 */
export function refundRequest({ amount, note, refundablePaise }) {
  const trimmed = String(note ?? '').trim();
  if (trimmed.length < 3 || trimmed.length > 300) {
    return { ok: false, message: 'Write a note of 3 to 300 characters.' };
  }
  const body = { reason: 'admin', note: trimmed };
  const text = String(amount ?? '').trim();
  if (text !== '') {
    const paise = rupeesToPaise(text);
    if (paise === null || paise < 1) {
      return { ok: false, message: 'Enter an amount like 250 or 250.50.' };
    }
    if (paise > refundablePaise) {
      return { ok: false, message: `At most ${formatINR(refundablePaise)} can still be refunded.` };
    }
    body.amountPaise = paise;
  }
  return { ok: true, body };
}

// ---- coupons ----

const COUPON_CODE = /^[A-Z0-9_-]{4,20}$/;

/** The create-coupon form -> an API body, or { ok: false, errors: { field: message } }. */
export function couponRequest(form) {
  const errors = {};
  const code = String(form.code ?? '')
    .trim()
    .toUpperCase();
  if (!COUPON_CODE.test(code)) errors.code = 'Use 4-20 letters, digits, "-" or "_".';

  let value;
  if (form.type === 'percent') {
    value = /^\d{1,2}$/.test(String(form.value).trim()) ? Number(form.value) : NaN;
    if (!(value >= 1 && value <= 90)) errors.value = 'A percentage from 1 to 90.';
  } else {
    value = rupeesToPaise(form.value);
    if (value === null || value < 100) errors.value = 'At least ₹1.00.';
  }

  const optionalMoney = (text, field) => {
    if (String(text ?? '').trim() === '') return undefined;
    const paise = rupeesToPaise(text);
    if (paise === null) errors[field] = 'Enter an amount like 500 or 500.50.';
    return paise ?? undefined;
  };
  const minOrderPaise = optionalMoney(form.minOrder, 'minOrder');
  const maxDiscountPaise = optionalMoney(form.maxDiscount, 'maxDiscount');
  if (maxDiscountPaise !== undefined && maxDiscountPaise < 1) {
    errors.maxDiscount = 'Must be above zero, or leave it empty.';
  }

  const startsAt = Date.parse(form.startsAt);
  const expiresAt = Date.parse(form.expiresAt);
  if (Number.isNaN(startsAt)) errors.startsAt = 'Pick a start time.';
  if (Number.isNaN(expiresAt)) errors.expiresAt = 'Pick an end time.';
  if (!errors.startsAt && !errors.expiresAt && expiresAt <= startsAt) {
    errors.expiresAt = 'The end must be after the start.';
  }

  const whole = (text, field, min) => {
    if (String(text ?? '').trim() === '') return undefined;
    const n = /^\d+$/.test(String(text).trim()) ? Number(text) : NaN;
    if (!(n >= min)) errors[field] = `A whole number, at least ${min}.`;
    return n;
  };
  const usageLimitTotal = whole(form.usageLimitTotal, 'usageLimitTotal', 1);
  const usageLimitPerUser = whole(form.usageLimitPerUser, 'usageLimitPerUser', 1);

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      code,
      type: form.type,
      value,
      ...(minOrderPaise !== undefined && { minOrderPaise }),
      ...(maxDiscountPaise !== undefined && { maxDiscountPaise }),
      startsAt: new Date(startsAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      ...(usageLimitTotal !== undefined && { usageLimitTotal }),
      ...(usageLimitPerUser !== undefined && { usageLimitPerUser }),
    },
  };
}

/** "10%" or "₹100.00" for a coupon row. */
export const couponValueLabel = (coupon) =>
  coupon.type === 'percent' ? `${coupon.value}%` : formatINR(coupon.value);

// ---- analytics ----

const iso = (date) => date.toISOString().slice(0, 10);

/** The page's starting range: the last 30 UTC days, today included (same as the API default). */
export function defaultRange(now = new Date()) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { from: iso(new Date(today - 29 * 86_400_000)), to: iso(new Date(today)) };
}

/** A fixed range the API would refuse (from after to) is caught before the request is sent. */
export const rangeIsValid = ({ from, to }) =>
  /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;

/**
 * Bar geometry for the sales chart: one bar per point, heights relative to the biggest value.
 * Pure arithmetic, so it can be tested without a browser. A zero value gets a zero-height bar.
 */
export function barLayout(points, key, { width = 720, height = 220, pad = 24 } = {}) {
  const max = Math.max(0, ...points.map((p) => p[key]));
  const slot = points.length ? (width - pad * 2) / points.length : 0;
  const barWidth = Math.max(1, slot * 0.7);
  const plotHeight = height - pad * 2;
  return {
    max,
    bars: points.map((p, i) => {
      const h = max > 0 ? Math.round((p[key] / max) * plotHeight) : 0;
      return {
        bucket: p.bucket,
        value: p[key],
        x: Math.round(pad + i * slot + (slot - barWidth) / 2),
        y: height - pad - h,
        width: Math.round(barWidth * 10) / 10,
        height: h,
      };
    }),
  };
}

/** Width of a horizontal bar, as a whole percentage of the largest value (0 when there is none). */
export const percentOf = (value, max) => (max > 0 ? Math.round((value / max) * 100) : 0);

export const settlementStatusText = (status) => status.replaceAll('_', ' ');
