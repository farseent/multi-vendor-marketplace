import { Router } from 'express';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { addressBody, addressParams, addressPatchBody, updateMeBody } from './users.validator.js';

export function createUsersRouter({ controller, authenticate }) {
  const router = Router();
  const customerOnly = [authenticate, authorize('customer')]; // addresses are for customers (C)

  router.get('/users/me', authenticate, controller.getMe);
  router.patch('/users/me', authenticate, validate({ body: updateMeBody }), controller.updateMe);

  router.get('/users/me/addresses', ...customerOnly, controller.listAddresses);
  router.post(
    '/users/me/addresses',
    ...customerOnly,
    validate({ body: addressBody }),
    controller.addAddress,
  );
  router.patch(
    '/users/me/addresses/:addressId',
    ...customerOnly,
    validate({ params: addressParams, body: addressPatchBody }),
    controller.updateAddress,
  );
  router.delete(
    '/users/me/addresses/:addressId',
    ...customerOnly,
    validate({ params: addressParams }),
    controller.deleteAddress,
  );
  return router;
}
