import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import {
  couponIdParams,
  createCouponBody,
  listCouponsQuery,
  updateCouponBody,
} from './coupons.validator.js';

/**
 * Paths relative to /api/v1. /vendor/* and /admin/* are role-gated structurally in app.js;
 * vendor routes also run `loadShop` so the vendor id comes from the shop record.
 */
export function createCouponsRouter({ controller, loadShop }) {
  const router = Router();

  router.get(
    '/vendor/coupons',
    loadShop,
    validate({ query: listCouponsQuery }),
    controller.vendorList,
  );
  router.post(
    '/vendor/coupons',
    loadShop,
    validate({ body: createCouponBody }),
    controller.vendorCreate,
  );
  router.get(
    '/vendor/coupons/:couponId',
    loadShop,
    validate({ params: couponIdParams }),
    controller.vendorGet,
  );
  router.patch(
    '/vendor/coupons/:couponId',
    loadShop,
    validate({ params: couponIdParams, body: updateCouponBody }),
    controller.vendorUpdate,
  );

  router.get('/admin/coupons', validate({ query: listCouponsQuery }), controller.adminList);
  router.post('/admin/coupons', validate({ body: createCouponBody }), controller.adminCreate);
  router.get('/admin/coupons/:couponId', validate({ params: couponIdParams }), controller.adminGet);
  router.patch(
    '/admin/coupons/:couponId',
    validate({ params: couponIdParams, body: updateCouponBody }),
    controller.adminUpdate,
  );
  return router;
}
