import { AppError } from '../lib/AppError.js';

/** Requires `Authorization: Bearer <accessToken>`; sets req.user = { id, role }. */
export function createAuthenticate(accessTokens) {
  return (req, _res, next) => {
    const [scheme, token] = (req.get('authorization') ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      return next(new AppError('UNAUTHENTICATED', 401, 'Authentication required'));
    }
    try {
      req.user = accessTokens.verify(token);
      next();
    } catch (err) {
      next(err);
    }
  };
}
