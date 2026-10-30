import { AppError } from '../lib/AppError.js';

/**
 * For /vendor/* routes that act on a shop's data. Looks the shop up from the authenticated user
 * on every request and sets req.vendor = { id, status }. The vendor id therefore never comes from
 * the body, params or token, and an approval or suspension takes effect immediately instead of
 * after the 15-minute access-token lifetime (D15).
 */
export function createLoadShop(shopsService) {
  return async (req, _res, next) => {
    try {
      const shop = await shopsService.findByUserId(req.user.id);
      if (!shop) throw new AppError('FORBIDDEN', 403, 'Create your shop profile first');
      req.vendor = { id: shop.id, status: shop.status };
      next();
    } catch (err) {
      next(err);
    }
  };
}
