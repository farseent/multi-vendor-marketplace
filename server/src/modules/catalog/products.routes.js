import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { searchQuery } from '../search/search.validator.js';
import {
  createProductBody,
  listProductsQuery,
  productIdParams,
  productSlugParams,
  stockBody,
  updateProductBody,
} from './products.validator.js';

/**
 * Paths relative to /api/v1. /vendor/* is role-gated in app.js; `loadShop` then resolves the
 * caller's shop (req.vendor) for every product route.
 */
export function createProductsRouter({ controller, searchController, loadShop, limiters }) {
  const router = Router();

  // Must stay ABOVE /products/:slug, otherwise "search" would be read as a slug.
  router.get(
    '/products/search',
    limiters.search,
    validate({ query: searchQuery }),
    searchController.search,
  );
  router.get('/products/:slug', validate({ params: productSlugParams }), controller.getPublic);

  router.get('/vendor/products', loadShop, validate({ query: listProductsQuery }), controller.list);
  router.post(
    '/vendor/products',
    loadShop,
    validate({ body: createProductBody }),
    controller.create,
  );
  router.get(
    '/vendor/products/:productId',
    loadShop,
    validate({ params: productIdParams }),
    controller.get,
  );
  router.patch(
    '/vendor/products/:productId',
    loadShop,
    validate({ params: productIdParams, body: updateProductBody }),
    controller.update,
  );
  router.delete(
    '/vendor/products/:productId',
    loadShop,
    validate({ params: productIdParams }),
    controller.archive,
  );
  router.patch(
    '/vendor/products/:productId/stock',
    loadShop,
    validate({ params: productIdParams, body: stockBody }),
    controller.setStock,
  );
  return router;
}