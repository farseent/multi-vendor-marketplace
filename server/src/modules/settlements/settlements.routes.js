import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import {
  adminSettlementsQuery,
  reportsQuery,
  settlementParams,
  vendorSettlementsQuery,
} from './settlements.validator.js';

/** Paths relative to /api/v1. /vendor/* and /admin/* are role-gated structurally in app.js. */
export function createSettlementsRouter({ controller, loadShop }) {
  const router = Router();
  router.get(
    '/vendor/settlements',
    loadShop,
    validate({ query: vendorSettlementsQuery }),
    controller.vendorList,
  );
  router.get(
    '/admin/settlements',
    validate({ query: adminSettlementsQuery }),
    controller.adminList,
  );
  router.post(
    '/admin/settlements/:settlementId/release',
    validate({ params: settlementParams }),
    controller.adminRelease,
  );
  router.get('/admin/reconciliation', validate({ query: reportsQuery }), controller.reportsList);
  router.post('/admin/reconciliation/run', controller.reportRun);
  return router;
}
