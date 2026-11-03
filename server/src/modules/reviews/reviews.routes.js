import { Router } from 'express';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import {
  createReviewBody,
  listReviewsQuery,
  productReviewsParams,
  reviewParams,
  reviewStatusBody,
  updateReviewBody,
} from './reviews.validator.js';

/**
 * Paths relative to /api/v1. Listing is public; writing is for customers (C) only and always acts
 * on the caller's own review. /admin/* is role-gated structurally in app.js.
 */
export function createReviewsRouter({ controller, authenticate }) {
  const router = Router();
  const customerOnly = [authenticate, authorize('customer')];

  router.get(
    '/products/:productId/reviews',
    validate({ params: productReviewsParams, query: listReviewsQuery }),
    controller.list,
  );
  router.get(
    '/products/:productId/reviews/mine',
    ...customerOnly,
    validate({ params: productReviewsParams }),
    controller.mine,
  );
  router.post(
    '/products/:productId/reviews',
    ...customerOnly,
    validate({ params: productReviewsParams, body: createReviewBody }),
    controller.create,
  );
  router.patch(
    '/reviews/:reviewId',
    ...customerOnly,
    validate({ params: reviewParams, body: updateReviewBody }),
    controller.update,
  );
  router.delete(
    '/reviews/:reviewId',
    ...customerOnly,
    validate({ params: reviewParams }),
    controller.remove,
  );
  router.patch(
    '/admin/reviews/:reviewId/status',
    validate({ params: reviewParams, body: reviewStatusBody }),
    controller.adminSetStatus,
  );
  return router;
}
