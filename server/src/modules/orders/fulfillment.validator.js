import { z } from 'zod';
import { FULFILLMENT_STATUSES } from '../../config/constants.js';
import { objectId, paginationQuery } from '../../lib/pagination.js';

export const subOrderParams = z.object({ subOrderId: objectId('sub-order id') });
export const cancelParams = z.object({
  orderId: objectId('order id'),
  subOrderId: objectId('sub-order id'),
});

export const vendorSubOrdersQuery = z.object({
  ...paginationQuery,
  // pending_payment sub-orders are never shown to a vendor, so it is not a valid filter either.
  fulfillmentStatus: z.enum(['processing', 'shipped', 'delivered', 'cancelled']).optional(),
});

const tracking = z.strictObject({
  carrier: z.string().trim().min(2).max(60),
  trackingNumber: z.string().trim().min(3).max(60),
});

// Any status value parses; whether the move is ALLOWED is the transition table's job (409).
export const statusBody = z
  .strictObject({ status: z.enum(FULFILLMENT_STATUSES), tracking: tracking.optional() })
  .superRefine((body, ctx) => {
    if (body.status === 'shipped' && !body.tracking) {
      ctx.addIssue({ code: 'custom', path: ['tracking'], message: 'Tracking is required to ship' });
    }
    if (body.status !== 'shipped' && body.tracking) {
      ctx.addIssue({
        code: 'custom',
        path: ['tracking'],
        message: 'Tracking is only for shipping',
      });
    }
  });
