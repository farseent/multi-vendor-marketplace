import { Router } from 'express';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { orderParams } from '../orders/orders.validator.js';

/** Paths relative to /api/v1. Invoices are for the order's owner, a customer (C), only. */
export function createInvoicesRouter({ controller, authenticate }) {
  const router = Router();
  router.get(
    '/orders/:orderId/invoice',
    authenticate,
    authorize('customer'),
    validate({ params: orderParams }),
    controller.download,
  );
  return router;
}
