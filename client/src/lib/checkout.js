import { apiFetch } from './api.js';
import { formatINR } from './money.js';

/** React Query keys and fetchers shared by the checkout, orders and order pages. */
export const ADDRESSES_KEY = ['addresses'];
export const fetchAddresses = async () => (await apiFetch('/users/me/addresses')).data;
export const ORDERS_KEY = ['orders'];
export const fetchOrders = async () => (await apiFetch('/orders')).data;
export const orderKey = (orderId) => ['order', orderId];
export const fetchOrder = async (orderId) => (await apiFetch(`/orders/${orderId}`)).data;

/**
 * A fresh Idempotency-Key for POST /checkout (the API accepts 8-100 characters of A-Z a-z 0-9 . _ : -).
 * The page keeps ONE key per attempt, so a double click or a retry after a dropped connection can
 * never create a second order.
 */
export function newIdempotencyKey(random = globalThis.crypto) {
  if (random?.randomUUID) return random.randomUUID();
  const bytes =
    random?.getRandomValues?.(new Uint8Array(16)) ??
    Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * After a failed checkout, may the same Idempotency-Key be sent again? Only when the answer never
 * arrived (network error): the order may exist. Any answer from the server means the attempt is
 * over, so the next try needs a new key.
 */
export const canReuseKey = (error) => error?.code === 'NETWORK_ERROR';

// What the customer sees for each documented checkout failure (API_CONTRACTS, DECISIONS D47-D50).
const VALIDATION_REASONS = {
  empty_cart: 'Your cart is empty.',
  zero_total: 'The order total would be zero. Remove the coupon or add more items.',
  below_minimum_total: 'The order total is below the minimum of ₹1.00.',
  payout_below_minimum:
    'One of the items is priced too low to be sold on its own. Add more to your order.',
};
const CONFLICT_REASONS = {
  unavailable: 'Some items are no longer available. Go back to your cart and remove them.',
  vendor_payout_unavailable:
    'A seller in your cart cannot accept payments yet. Remove their items to continue.',
};
const COUPON_REASONS = {
  exceeds_platform_margin: 'This coupon cannot be used with these items. Remove it and try again.',
  expired: 'Your coupon has expired.',
  disabled: 'Your coupon is no longer active.',
  not_started: 'Your coupon is not valid yet.',
  not_found: 'Your coupon no longer exists.',
  wrong_vendor: 'Your coupon is for a shop that is not in your cart.',
  below_min_order: 'Your cart is below the minimum amount for this coupon.',
  total_limit_reached: 'Your coupon has been fully used.',
  user_limit_reached: 'You have already used your coupon the maximum number of times.',
};

/** One readable sentence for any error from POST /checkout or POST /payments/verify. */
export function checkoutErrorMessage(error) {
  const reason = error?.details?.reason;
  switch (error?.code) {
    case 'OUT_OF_STOCK':
      return 'Some items do not have enough stock any more. Go back to your cart and adjust them.';
    case 'COUPON_INVALID':
      return COUPON_REASONS[reason] ?? 'Your coupon cannot be applied.';
    case 'VALIDATION_ERROR':
      return VALIDATION_REASONS[reason] ?? error.message;
    case 'CONFLICT':
      return CONFLICT_REASONS[reason] ?? error.message;
    case 'PAYMENT_PROVIDER_ERROR':
      return 'The payment service is unavailable right now. Your cart is unchanged; please try again.';
    case 'PAYMENT_VERIFICATION_FAILED':
      return 'We could not confirm your payment. If money was taken it will be refunded; check your orders.';
    case 'RATE_LIMITED':
      return 'Too many attempts. Please wait a minute and try again.';
    case 'NETWORK_ERROR':
      return 'Cannot reach the server. Check your connection and try again.';
    default:
      return error?.message ?? 'Something went wrong.';
  }
}

/** A short status line for an order: what happened and what the customer can do. */
export function orderStatusLabel(order) {
  if (order.status === 'expired') {
    return order.refundStatus === 'full'
      ? 'Expired: your payment arrived too late and was refunded in full'
      : 'Expired: payment was not completed in time';
  }
  if (order.status === 'pending_payment') return 'Waiting for payment';
  if (order.status === 'cancelled') return 'Cancelled';
  if (order.status === 'completed') return 'Completed';
  return order.paymentStatus === 'paid' ? 'Paid' : 'Placed';
}

/** Whole seconds left on a reservation (never below 0). */
export function secondsLeft(reservationExpiresAt, now = Date.now()) {
  if (!reservationExpiresAt) return 0;
  return Math.max(0, Math.ceil((new Date(reservationExpiresAt).getTime() - now) / 1000));
}

/** 754 -> "12:34". */
export function formatCountdown(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The body of POST /payments/verify from what Razorpay Checkout (or the mock) hands back. */
export const toVerifyBody = (orderId, response) => ({
  orderId,
  razorpayOrderId: response.razorpay_order_id ?? response.razorpayOrderId,
  razorpayPaymentId: response.razorpay_payment_id ?? response.razorpayPaymentId,
  razorpaySignature: response.razorpay_signature ?? response.razorpaySignature,
});

/**
 * Options for Razorpay Standard Checkout. The amount and the order id come from OUR server (the
 * widget cannot change what is charged); no secret is involved, only the public key id.
 */
export function buildCheckoutOptions({ payment, order, user, onPaid, onDismiss }) {
  return {
    key: payment.keyId,
    order_id: payment.providerOrderId,
    amount: payment.amountPaise,
    currency: payment.currency,
    name: 'Marketplace',
    description: `Order ${order.orderNumber} (${formatINR(payment.amountPaise)})`,
    prefill: { name: user?.name, email: user?.email },
    handler: onPaid,
    modal: { ondismiss: onDismiss },
  };
}

const CHECKOUT_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';
let scriptPromise = null;
/** Loads Razorpay's checkout.js once, only when a customer is about to pay. */
export function loadRazorpayCheckout() {
  if (globalThis.Razorpay) return Promise.resolve(globalThis.Razorpay);
  scriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_SCRIPT;
    script.async = true;
    script.onload = () => resolve(globalThis.Razorpay);
    script.onerror = () => {
      scriptPromise = null; // allow a retry
      reject(new Error('Could not load the payment window. Check your connection.'));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}
