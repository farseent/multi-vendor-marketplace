import { z } from 'zod';
import {
  ANALYTICS,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  PRODUCT_STATUSES,
  REFUND_STATUSES,
  REVIEW_STATUSES,
} from '../../config/constants.js';
import { objectId, paginationQuery } from '../../lib/pagination.js';

// A free-text filter: trimmed, bounded, and only ever used as an escaped literal (never a regex).
const searchText = z.string().trim().min(1).max(100);

export const productIdParams = z.object({ productId: objectId('product id') });
export const orderIdParams = z.object({ orderId: objectId('order id') });

export const adminProductsQuery = z.object({
  status: z.enum(PRODUCT_STATUSES).optional(),
  vendorId: objectId('vendor id').optional(),
  q: searchText.optional(),
  ...paginationQuery,
});

// "suspended" hides a product; "draft" is the only way back: the vendor must publish it again (D65).
export const productStatusBody = z.strictObject({
  status: z.enum(['suspended', 'draft']),
});

export const adminReviewsQuery = z.object({
  status: z.enum(REVIEW_STATUSES).optional(),
  productId: objectId('product id').optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  ...paginationQuery,
});

export const adminOrdersQuery = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  refundStatus: z.enum(REFUND_STATUSES).optional(),
  q: searchText.optional(), // order number, or the start of one
  ...paginationQuery,
});

// ---- analytics ----

// A calendar date in UTC, `YYYY-MM-DD`. 2026-02-31 is refused rather than rolled over.
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }, 'Not a real date');

const rangeFields = { from: day.optional(), to: day.optional() };
const rangeRules = (v) => !v.from || !v.to || v.from <= v.to; // YYYY-MM-DD sorts as text

export const analyticsRangeQuery = z
  .object(rangeFields)
  .refine(rangeRules, { message: '`from` must not be after `to`', path: ['from'] });

export const salesTimeseriesQuery = z
  .object({ ...rangeFields, interval: z.enum(ANALYTICS.intervals).default('day') })
  .refine(rangeRules, { message: '`from` must not be after `to`', path: ['from'] });

export const topQuery = z
  .object({
    ...rangeFields,
    limit: z.coerce.number().int().min(1).max(ANALYTICS.topMax).default(ANALYTICS.topDefault),
  })
  .refine(rangeRules, { message: '`from` must not be after `to`', path: ['from'] });
