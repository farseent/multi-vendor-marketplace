import { z } from 'zod';
import { CART } from '../../config/constants.js';
import { objectId } from '../../lib/pagination.js';

export const cartItemParams = z.object({ productId: objectId('product id') });

// 0 removes the line. More than 10 is a 422 (API_CONTRACTS / IMPLEMENTATION_PLAN Phase 4).
export const setQuantityBody = z.strictObject({
  quantity: z.number().int().min(0).max(CART.maxQuantity),
});

// Any text is accepted here; an unknown code is answered as COUPON_INVALID (not_found), which
// is friendlier than a format error for a mistyped code.
export const applyCouponBody = z.strictObject({
  code: z.string().trim().toUpperCase().min(1).max(40),
});
