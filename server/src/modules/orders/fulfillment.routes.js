import { Router } from 'express';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import {
  cancelParams,
  statusBody,
  subOrderParams,
  vendorSubOrdersQuery,
} from './fulfillment.validator.js';

/**
 * Paths relative to /api/v1. /vendor/* is role-gated structurally in app.js; the vendor id comes
 * from `loadShop`. Cancelling is the customer's own action (C): another customer's sub-order is a 404.
 */
export function createFulfillmentRouter({ controller, authenticate, loadShop }) {
  const router = Router();

  router.get(
    '/vendor/sub-orders',
    loadShop,
    validate({ query: vendorSubOrdersQuery }),
    controller.vendorList,
  );
  router.get(
    '/vendor/sub-orders/:subOrderId',
    loadShop,
    validate({ params: subOrderParams }),
    controller.vendorGet,
  );
  router.patch(
    '/vendor/sub-orders/:subOrderId/status',
    loadShop,
    validate({ params: subOrderParams, body: statusBody }),
    controller.vendorUpdateStatus,
  );
  router.post(
    '/orders/:orderId/sub-orders/:subOrderId/cancel',
    authenticate,
    authorize('customer'),
    validate({ params: cancelParams }),
    controller.customerCancel,
  );
  return router;
}
