import { z } from 'zod';
import { IDEMPOTENCY_KEY } from '../../config/constants.js';
import { AppError } from '../../lib/AppError.js';
import { objectId } from '../../lib/pagination.js';

export const refundParams = z.object({ subOrderId: objectId('sub-order id') });

// `reason` is part of the contract; an admin's refund is always `admin` (the other reasons are
// written by the system when a sub-order is cancelled).
export const refundBody = z.strictObject({
  amountPaise: z.number().int().min(1).max(100_000_000).optional(),
  reason: z.literal('admin'),
  note: z.string().trim().min(3).max(300),
});

const keySchema = z
  .string()
  .min(IDEMPOTENCY_KEY.min)
  .max(IDEMPOTENCY_KEY.max)
  .regex(IDEMPOTENCY_KEY.pattern, 'Use letters, digits and . _ : -');

/** The Idempotency-Key header is OPTIONAL on refunds (API_CONTRACTS section 1). */
export function readOptionalIdempotencyKey(req) {
  const raw = req.get('idempotency-key');
  if (raw === undefined) return undefined;
  const result = keySchema.safeParse(raw);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 422, 'Invalid request', [
      { path: 'headers.idempotency-key', message: result.error.issues[0].message },
    ]);
  }
  return result.data;
}
