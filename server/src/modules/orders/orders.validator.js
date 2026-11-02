import { z } from 'zod';
import { IDEMPOTENCY_KEY } from '../../config/constants.js';
import { AppError } from '../../lib/AppError.js';
import { objectId, paginationQuery } from '../../lib/pagination.js';

// couponCode: omitted = use the coupon saved in the cart; null = no coupon; a string = that code.
export const checkoutBody = z.strictObject({
  addressId: objectId('address id'),
  couponCode: z.string().trim().toUpperCase().min(1).max(40).nullable().optional(),
});

export const orderParams = z.object({ orderId: objectId('order id') });
export const listOrdersQuery = z.object({ ...paginationQuery });

const keySchema = z
  .string()
  .min(IDEMPOTENCY_KEY.min)
  .max(IDEMPOTENCY_KEY.max)
  .regex(IDEMPOTENCY_KEY.pattern, 'Use letters, digits and . _ : -');

/** The Idempotency-Key header is required on POST /checkout (API_CONTRACTS). */
export function readIdempotencyKey(req) {
  const result = keySchema.safeParse(req.get('idempotency-key'));
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 422, 'Invalid request', [
      {
        path: 'headers.idempotency-key',
        message: req.get('idempotency-key')
          ? result.error.issues[0].message
          : 'The Idempotency-Key header is required',
      },
    ]);
  }
  return result.data;
}
