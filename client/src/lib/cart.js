import { apiFetch } from './api.js';

/** React Query key and fetcher for the cart, shared by the header, product page and cart page. */
export const CART_KEY = ['cart'];
export const fetchCart = async () => (await apiFetch('/cart')).data;

export const MAX_QUANTITY = 10; // same limit the API enforces (422 above it)

// Messages for COUPON_INVALID details.reason (API_CONTRACTS). Unknown reasons get a safe default.
const COUPON_MESSAGES = {
  not_found: 'That coupon code does not exist.',
  disabled: 'This coupon is not active.',
  not_started: 'This coupon is not valid yet.',
  expired: 'This coupon has expired.',
  empty_cart: 'Add something to your cart before using a coupon.',
  wrong_vendor: 'This coupon is for a shop that is not in your cart.',
  below_min_order: 'Your cart is below the minimum amount for this coupon.',
  total_limit_reached: 'This coupon has been fully used.',
  user_limit_reached: 'You have already used this coupon the maximum number of times.',
};
export const couponReasonMessage = (reason) =>
  COUPON_MESSAGES[reason] ?? 'This coupon cannot be applied.';

/** A short warning for a cart line that needs attention, or null when the line is fine. */
export function lineNotice(line) {
  if (line.status === 'unavailable') return 'No longer available. Remove it to continue.';
  if (line.status === 'insufficient_stock') {
    return line.available > 0
      ? `Only ${line.available} left in stock. Lower the quantity.`
      : 'Out of stock. Remove it to continue.';
  }
  return null;
}

/** How many more of a product can be added when `inCart` are already there (never below 0). */
export const roomLeft = (inCart) => Math.max(0, MAX_QUANTITY - inCart);
