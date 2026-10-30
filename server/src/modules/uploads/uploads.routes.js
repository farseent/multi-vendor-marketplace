import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { presignBody } from './uploads.validator.js';

/** Presign needs a shop (its id is in the key) but not an approved one: drafts need images too. */
export function createUploadsRouter({ controller, loadShop, limiters }) {
  const router = Router();
  router.post(
    '/vendor/uploads/presign',
    loadShop,
    limiters.presign,
    validate({ body: presignBody }),
    controller.presign,
  );
  return router;
}
