import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import {
  categoryIdParams,
  createCategoryBody,
  updateCategoryBody,
} from './categories.validator.js';

/** Paths relative to /api/v1. /admin/* is role-gated by the structural guard in app.js. */
export function createCategoriesRouter({ controller }) {
  const router = Router();
  router.get('/categories', controller.tree); // public
  router.get('/admin/categories', controller.listAll);
  router.post('/admin/categories', validate({ body: createCategoryBody }), controller.create);
  router.patch(
    '/admin/categories/:categoryId',
    validate({ params: categoryIdParams, body: updateCategoryBody }),
    controller.update,
  );
  return router;
}
