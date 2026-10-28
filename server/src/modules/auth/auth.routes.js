import cookieParser from 'cookie-parser';
import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { changePasswordBody, loginBody, registerBody } from './auth.validator.js';

/** Paths are relative to /api/v1 (no nested routers, so the route table stays enumerable). */
export function createAuthRouter({ controller, authenticate, limiters, originCheck }) {
  const router = Router();
  const cookies = cookieParser(); // only the routes that read the refresh cookie pay for parsing

  router.post(
    '/auth/register',
    limiters.register,
    validate({ body: registerBody }),
    controller.register,
  );
  router.post(
    '/auth/register-vendor',
    limiters.register,
    validate({ body: registerBody }),
    controller.registerVendor,
  );
  router.post('/auth/login', limiters.login, validate({ body: loginBody }), controller.login);
  router.post('/auth/refresh', originCheck, cookies, controller.refresh);
  router.post('/auth/logout', originCheck, cookies, controller.logout);
  router.get('/auth/me', authenticate, controller.me);
  router.post(
    '/auth/change-password',
    authenticate,
    limiters.changePassword,
    cookies,
    validate({ body: changePasswordBody }),
    controller.changePassword,
  );
  return router;
}
