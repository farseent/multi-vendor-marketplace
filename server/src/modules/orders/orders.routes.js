import { Router } from 'express';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { checkoutBody, listOrdersQuery, orderParams } from './orders.validator.js';

/** Paths relative to /api/v1. Checkout and orders are for customers only (C). */
export function createOrdersRouter({ controller, authenticate, limiters }) {
  const router = Router();
  const customerOnly = [authenticate, authorize('customer')];

  router.post(
    '/checkout',
    ...customerOnly,
    limiters.checkout,
    validate({ body: checkoutBody }),
    controller.checkout,
  );
  router.get('/orders', ...customerOnly, validate({ query: listOrdersQuery }), controller.list);
  router.get(
    '/orders/:orderId',
    ...customerOnly,
    validate({ params: orderParams }),
    controller.get,
  );
  return router;
}
