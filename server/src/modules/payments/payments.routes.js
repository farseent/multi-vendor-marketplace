import { Router } from 'express';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { mockCompleteBody, verifyBody } from './payments.validator.js';

/** Paths relative to /api/v1. The browser-facing payment routes are for customers only (C). */
export function createPaymentsRouter({ controller, authenticate }) {
  const router = Router();
  const customerOnly = [authenticate, authorize('customer')];

  router.post(
    '/payments/verify',
    ...customerOnly,
    validate({ body: verifyBody }),
    controller.verify,
  );
  // Development only: answers 404 unless the MockLedger runs outside production.
  router.post(
    '/payments/mock/complete',
    ...customerOnly,
    validate({ body: mockCompleteBody }),
    controller.mockComplete,
  );
  return router;
}
