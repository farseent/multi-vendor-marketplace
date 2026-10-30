import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import {
  commissionBody,
  createShopBody,
  listVendorsQuery,
  shopSlugParams,
  updateShopBody,
  vendorIdParams,
  vendorStatusBody,
} from './shops.validator.js';

/**
 * Paths are relative to /api/v1. Everything under /vendor and /admin is already role-gated by
 * the structural guard in app.js (authenticate + authorize), so those routes do not repeat it.
 */
export function createShopsRouter({ controller }) {
  const router = Router();

  // Public: approved shops only
  router.get('/shops/:shopSlug', validate({ params: shopSlugParams }), controller.getPublic);

  // Vendor console (a pending shop may use these)
  router.get('/vendor/profile', controller.getOwn);
  router.post('/vendor/profile', validate({ body: createShopBody }), controller.createOwn);
  router.patch('/vendor/profile', validate({ body: updateShopBody }), controller.updateOwn);

  // Admin
  router.get('/admin/vendors', validate({ query: listVendorsQuery }), controller.listVendors);
  router.patch(
    '/admin/vendors/:vendorId/status',
    validate({ params: vendorIdParams, body: vendorStatusBody }),
    controller.setStatus,
  );
  router.patch(
    '/admin/vendors/:vendorId/commission',
    validate({ params: vendorIdParams, body: commissionBody }),
    controller.setCommission,
  );
  return router;
}
