import { z } from 'zod';
import { REVIEW, REVIEW_STATUSES } from '../../config/constants.js';
import { objectId, paginationQuery } from '../../lib/pagination.js';

const rating = z.number().int().min(1).max(5);
const title = z.string().trim().min(1).max(REVIEW.titleMax);
const body = z.string().trim().min(REVIEW.bodyMin).max(REVIEW.bodyMax);

export const productReviewsParams = z.object({ productId: objectId('product id') });
export const reviewParams = z.object({ reviewId: objectId('review id') });

export const listReviewsQuery = z.object({
  ...paginationQuery,
  sort: z.enum(REVIEW.sorts).default('-createdAt'),
});

export const createReviewBody = z.strictObject({ rating, title: title.optional(), body });

// At least one field; `title: null` removes the title.
export const updateReviewBody = z
  .strictObject({
    rating: rating.optional(),
    title: title.nullable().optional(),
    body: body.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field' });

export const reviewStatusBody = z.strictObject({ status: z.enum(REVIEW_STATUSES) });
