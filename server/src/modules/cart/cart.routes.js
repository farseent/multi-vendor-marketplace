import { Router } from 'express';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { applyCouponBody, cartItemParams, setQuantityBody } from './cart.validator.js';

/** Paths relative to /api/v1. The cart is for customers only (C): other roles get 403. */
export function createCartRouter({ controller, authenticate }) {
  const router = Router();
  const customerOnly = [authenticate, authorize('customer')];

  router.get('/cart', ...customerOnly, controller.get);
  router.delete('/cart', ...customerOnly, controller.clear);
  router.put(
    '/cart/items/:productId',
    ...customerOnly,
    validate({ params: cartItemParams, body: setQuantityBody }),
    controller.setQuantity,
  );
  router.delete(
    '/cart/items/:productId',
    ...customerOnly,
    validate({ params: cartItemParams }),
    controller.removeItem,
  );
  router.post(
    '/cart/coupon',
    ...customerOnly,
    validate({ body: applyCouponBody }),
    controller.applyCoupon,
  );
  router.delete('/cart/coupon', ...customerOnly, controller.removeCoupon);
  return router;
}
