import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { refundBody, refundParams } from './refunds.validator.js';

/** Paths relative to /api/v1. /admin/* is role-gated structurally in app.js. */
export function createRefundsRouter({ controller }) {
  const router = Router();
  router.post(
    '/admin/sub-orders/:subOrderId/refund',
    validate({ params: refundParams, body: refundBody }),
    controller.adminRefund,
  );
  return router;
}
