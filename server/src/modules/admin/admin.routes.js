import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import {
  adminOrdersQuery,
  adminProductsQuery,
  adminReviewsQuery,
  analyticsRangeQuery,
  orderIdParams,
  productIdParams,
  productStatusBody,
  salesTimeseriesQuery,
  topQuery,
} from './admin.validator.js';

/**
 * Paths relative to /api/v1. /admin/* is role-gated structurally in app.js (authenticate +
 * authorize('admin')), so none of these can be reached by another role.
 */
export function createAdminRouter({ controller }) {
  const router = Router();

  router.get('/admin/products', validate({ query: adminProductsQuery }), controller.listProducts);
  router.patch(
    '/admin/products/:productId/status',
    validate({ params: productIdParams, body: productStatusBody }),
    controller.setProductStatus,
  );
  router.get('/admin/reviews', validate({ query: adminReviewsQuery }), controller.listReviews);
  router.get('/admin/orders', validate({ query: adminOrdersQuery }), controller.listOrders);
  router.get('/admin/orders/:orderId', validate({ params: orderIdParams }), controller.getOrder);

  router.get(
    '/admin/analytics/overview',
    validate({ query: analyticsRangeQuery }),
    controller.overview,
  );
  router.get(
    '/admin/analytics/sales-timeseries',
    validate({ query: salesTimeseriesQuery }),
    controller.salesTimeseries,
  );
  router.get('/admin/analytics/top-vendors', validate({ query: topQuery }), controller.topVendors);
  router.get(
    '/admin/analytics/top-products',
    validate({ query: topQuery }),
    controller.topProducts,
  );
  return router;
}
