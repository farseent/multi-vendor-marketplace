import { VENDOR_TRANSITIONS } from '../../config/constants.js';
import { AppError } from '../../lib/AppError.js';
import { pageMeta, skipFor } from '../../lib/pagination.js';
import { isDuplicateOn, shortId, slugify } from '../../lib/slug.js';
import { isOwnedKey } from '../../lib/uploadKeys.js';
import { User } from '../users/users.model.js';
import { Vendor } from './shops.model.js';

const notFound = () => new AppError('NOT_FOUND', 404, 'Shop not found');
const MAX_SLUG_ATTEMPTS = 5;

/** Shop rules: one shop per vendor user, admin approval, commission override. */
export function createShopsService({ audit, storage = null }) {
  const logoUrl = (key) => (key && storage ? storage.publicUrl(key) : null);

  // What the shop owner sees (everything, including status and commission).
  const presentOwn = (shop) => ({ ...shop.toJSON(), logoUrl: logoUrl(shop.logoKey) });

  // What the public sees: no status, no commission, no payout data, no owner.
  const presentPublic = (shop) => ({
    id: shop.id,
    shopName: shop.shopName,
    shopSlug: shop.shopSlug,
    description: shop.description ?? null,
    logoUrl: logoUrl(shop.logoKey),
  });

  const findByUserId = (userId) => Vendor.findOne({ userId });

  async function loadVendor(vendorId) {
    const shop = await Vendor.findById(vendorId);
    if (!shop) throw notFound();
    return shop;
  }

  return {
    findByUserId,

    async getOwn(userId) {
      const shop = await findByUserId(userId);
      if (!shop) throw new AppError('NOT_FOUND', 404, 'You have not created a shop yet');
      return presentOwn(shop);
    },

    async createOwn(userId, { shopName, description }) {
      if (await findByUserId(userId)) {
        throw new AppError('CONFLICT', 409, 'You already have a shop');
      }
      const base = slugify(shopName, { fallback: 'shop' });
      for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
        // First try the clean slug; on a collision add a short random suffix.
        const shopSlug = attempt === 0 ? base : `${base}-${shortId()}`;
        try {
          const shop = await Vendor.create({ userId, shopName, description, shopSlug });
          return presentOwn(shop);
        } catch (err) {
          if (isDuplicateOn(err, 'shopSlug')) continue;
          if (isDuplicateOn(err, 'userId')) {
            throw new AppError('CONFLICT', 409, 'You already have a shop'); // lost a race
          }
          throw err;
        }
      }
      throw new AppError('CONFLICT', 409, 'Could not generate a unique shop URL, try another name');
    },

    async updateOwn(userId, patch) {
      const shop = await findByUserId(userId);
      if (!shop) throw new AppError('NOT_FOUND', 404, 'You have not created a shop yet');

      if (patch.logoKey && !isOwnedKey(patch.logoKey, shop.id)) {
        throw new AppError('VALIDATION_ERROR', 422, 'Invalid request', [
          { path: 'body.logoKey', message: 'Logo key must be an upload made for your shop' },
        ]);
      }
      // The slug is deliberately not regenerated: shop URLs must stay stable.
      if (patch.shopName !== undefined) shop.shopName = patch.shopName;
      if (patch.description !== undefined) shop.description = patch.description ?? undefined;
      if (patch.logoKey !== undefined) shop.logoKey = patch.logoKey ?? undefined;
      await shop.save();
      return presentOwn(shop);
    },

    /** Public page: only approved shops exist as far as visitors are concerned. */
    async getPublicBySlug(shopSlug) {
      const shop = await Vendor.findOne({ shopSlug, status: 'approved' });
      if (!shop) throw notFound();
      return presentPublic(shop);
    },

    // --- admin ---

    async listForAdmin({ status, page, limit }) {
      const filter = status ? { status } : {};
      const [shops, total] = await Promise.all([
        Vendor.find(filter).sort({ createdAt: -1 }).skip(skipFor({ page, limit })).limit(limit),
        Vendor.countDocuments(filter),
      ]);
      const owners = await User.find({ _id: { $in: shops.map((s) => s.userId) } });
      const ownerById = new Map(owners.map((u) => [u.id, u]));
      const items = shops.map((shop) => {
        const owner = ownerById.get(String(shop.userId));
        return {
          ...presentOwn(shop),
          owner: owner ? { id: owner.id, name: owner.name, email: owner.email } : null,
        };
      });
      return { items, meta: pageMeta({ page, limit }, total) };
    },

    async setStatus(actor, vendorId, status) {
      const shop = await loadVendor(vendorId);
      const from = shop.status;
      if (!VENDOR_TRANSITIONS[from]?.includes(status)) {
        throw new AppError(
          'INVALID_STATE_TRANSITION',
          409,
          `A ${from} shop cannot be changed to ${status}`,
        );
      }
      // Conditional update: if two admins act at once, only the one that saw `from` wins.
      const updated = await Vendor.findOneAndUpdate(
        { _id: shop._id, status: from },
        { status },
        { returnDocument: 'after' },
      );
      if (!updated) {
        throw new AppError(
          'INVALID_STATE_TRANSITION',
          409,
          'Shop status changed, reload and retry',
        );
      }
      await audit.record(actor, {
        action: 'vendor.status_changed',
        entityType: 'vendor',
        entityId: shop._id,
        meta: { from, to: status },
      });
      return presentOwn(updated);
    },

    async setCommission(actor, vendorId, commissionRateBps) {
      const shop = await loadVendor(vendorId);
      const from = shop.commissionRateBps ?? null;
      shop.commissionRateBps = commissionRateBps;
      await shop.save();
      await audit.record(actor, {
        action: 'vendor.commission_changed',
        entityType: 'vendor',
        entityId: shop._id,
        meta: { from, to: commissionRateBps },
      });
      return presentOwn(shop);
    },
  };
}
