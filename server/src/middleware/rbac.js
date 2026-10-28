import { AppError } from '../lib/AppError.js';

/** Must run after `authenticate`. Allows only the listed roles, otherwise 403. */
export const authorize =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(new AppError('UNAUTHENTICATED', 401, 'Authentication required'));
    if (!roles.includes(req.user.role)) {
      return next(new AppError('FORBIDDEN', 403, 'You do not have access to this resource'));
    }
    next();
  };
