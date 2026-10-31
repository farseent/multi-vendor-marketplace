import mongoose from 'mongoose';
import { CACHE } from '../../config/constants.js';
import { AppError } from '../../lib/AppError.js';
import { pageMeta, skipFor } from '../../lib/pagination.js';
import { isDuplicateOn, shortId, slugify } from '../../lib/slug.js';
import { isOwnedKey } from '../../lib/uploadKeys.js';
import { Vendor } from '../shops/shops.model.js';
import { Category } from './categories.model.js';
import { Product } from './products.model.js';

const MAX_SLUG_ATTEMPTS = 5;
const notFound = () => new AppError('NOT_FOUND', 404, 'Product not found');
const invalid = (path, message) =>
  new AppError('VALIDATION_ERROR', 422, 'Invalid request', [{ path: `body.${path}`, message }]);

// Runs `work(session)` as one Mongo transaction (needs a replica set, see docker-compose).
const inTransaction = (work) => mongoose.connection.transaction(work);

/**
 * `searchOutbox` and `cache` are required: every product write enqueues a search-index entry in
 * the SAME transaction (so it cannot be lost), and drops the cached detail page after commit.
 */
export function createProductsService({ storage = null, searchOutbox, cache }) {
  const invalidate = (product) => cache.del(CACHE.keys.product(product.slug));

  const imageUrl = (key) => (storage ? storage.publicUrl(key) : null);

  // Vendor console view: every field, with image URLs added.
  const presentOwn = (product) => {
    const json = product.toJSON();
    return { ...json, images: json.images.map((img) => ({ ...img, url: imageUrl(img.key) })) };
  };

  // Public view: explicit allow-list, so a new internal field never leaks by accident.
  const presentPublic = (product, shop) => ({
    id: product.id,
    slug: product.slug,
    title: product.title,
    description: product.description ?? null,
    categoryId: String(product.categoryId),
    pricePaise: product.pricePaise,
    compareAtPricePaise: product.compareAtPricePaise ?? null,
    images: product.images.map((img) => ({ url: imageUrl(img.key), alt: img.alt ?? null })),
    attributes: Object.fromEntries(product.attributes ?? []),
    ratingAvg: product.ratingAvg,
    ratingCount: product.ratingCount,
    inStock: product.stockQty > 0, // the exact quantity stays private
    shop: { name: shop.shopName, slug: shop.shopSlug },
    createdAt: product.createdAt,
  });

  // Only an approved shop may have active products.
  function assertCanPublish(vendor) {
    if (vendor.status !== 'approved') {
      throw new AppError(
        'VENDOR_NOT_APPROVED',
        403,
        'Your shop must be approved before you can publish products',
      );
    }
  }

  async function assertCategory(categoryId) {
    if (!(await Category.exists({ _id: categoryId, isActive: true }))) {
      throw invalid('categoryId', 'Category not found or inactive');
    }
  }

  // Every image key must live under this vendor's own prefix (blocks another vendor's files).
  function assertImageKeys(images, vendorId) {
    const details = [];
    images.forEach((img, i) => {
      if (!isOwnedKey(img.key, vendorId)) {
        details.push({
          path: `body.images.${i}.key`,
          message: 'Image key must be an upload made for your shop',
        });
      }
    });
    if (details.length) throw new AppError('VALIDATION_ERROR', 422, 'Invalid request', details);
  }

  // Ownership is part of the query: another vendor's product is simply "not found" (D15).
  async function loadOwn(vendorId, productId, session = null) {
    const product = await Product.findOne({ _id: productId, vendorId }).session(session);
    if (!product) throw notFound();
    return product;
  }

  return {
    async create(vendor, data) {
      if (data.status === 'active') assertCanPublish(vendor);
      await assertCategory(data.categoryId);
      assertImageKeys(data.images, vendor.id);

      const base = slugify(data.title, { fallback: 'product', maxLength: 60 });
      for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
        try {
          const product = await inTransaction(async (session) => {
            const [created] = await Product.create(
              [
                {
                  ...data,
                  vendorId: vendor.id, // from the shop record, never from the request body
                  slug: `${base}-${shortId()}`,
                },
              ],
              { session },
            );
            // A draft is not searchable yet, so only a product created active needs indexing.
            if (created.status === 'active') await searchOutbox.enqueue([created._id], { session });
            return created;
          });
          return presentOwn(product);
        } catch (err) {
          if (isDuplicateOn(err, 'slug')) continue; // astronomically rare: try another suffix
          throw err; // duplicate SKU etc. become 409 in the error handler
        }
      }
      throw new AppError('CONFLICT', 409, 'Could not generate a unique product URL, retry');
    },

    async list(vendorId, { status, sort, page, limit }) {
      const filter = { vendorId, ...(status && { status }) };
      const order = sort.startsWith('-') ? { [sort.slice(1)]: -1 } : { [sort]: 1 };
      const [items, total] = await Promise.all([
        Product.find(filter).sort(order).skip(skipFor({ page, limit })).limit(limit),
        Product.countDocuments(filter),
      ]);
      return { items: items.map(presentOwn), meta: pageMeta({ page, limit }, total) };
    },

    async getOwn(vendorId, productId) {
      return presentOwn(await loadOwn(vendorId, productId));
    },

    async update(vendor, productId, patch) {
      const product = await loadOwn(vendor.id, productId);

      if (product.status === 'suspended' && patch.status !== undefined) {
        throw new AppError(
          'INVALID_STATE_TRANSITION',
          409,
          'This product was suspended by an admin and cannot be changed',
        );
      }
      if (patch.status === 'active') assertCanPublish(vendor);
      if (patch.categoryId) await assertCategory(patch.categoryId);
      if (patch.images) assertImageKeys(patch.images, vendor.id);

      const price = patch.pricePaise ?? product.pricePaise;
      const compareAt =
        patch.compareAtPricePaise === undefined
          ? product.compareAtPricePaise
          : patch.compareAtPricePaise;
      if (compareAt != null && compareAt <= price) {
        throw invalid('compareAtPricePaise', 'Must be greater than the price');
      }

      const { attributes, description, compareAtPricePaise, ...plain } = patch;
      product.set(plain);
      if (description !== undefined) product.description = description ?? undefined;
      if (compareAtPricePaise !== undefined)
        product.compareAtPricePaise = compareAtPricePaise ?? undefined;
      if (attributes !== undefined) {
        product.attributes = attributes ? new Map(Object.entries(attributes)) : undefined;
      }
      await inTransaction(async (session) => {
        await product.save({ session });
        await searchOutbox.enqueue([product._id], { session });
      });
      await invalidate(product);
      return presentOwn(product);
    },

    /** DELETE archives (keeps order history intact). Idempotent. */
    async archive(vendorId, productId) {
      const product = await loadOwn(vendorId, productId);
      if (product.status === 'suspended') {
        throw new AppError(
          'INVALID_STATE_TRANSITION',
          409,
          'This product was suspended by an admin and cannot be changed',
        );
      }
      if (product.status !== 'archived') {
        product.status = 'archived';
        await inTransaction(async (session) => {
          await product.save({ session });
          await searchOutbox.enqueue([product._id], { session });
        });
        await invalidate(product);
      }
      return presentOwn(product);
    },

    /** Absolute set in one atomic update, scoped to the owner. */
    async setStock(vendorId, productId, stockQty) {
      const product = await inTransaction(async (session) => {
        const before = await Product.findOne({ _id: productId, vendorId }, { stockQty: 1 }).session(
          session,
        );
        if (!before) throw notFound();
        const updated = await Product.findOneAndUpdate(
          { _id: productId, vendorId },
          { $set: { stockQty } },
          { returnDocument: 'after', session },
        );
        // The index only stores "in stock yes/no", so it needs updating only when that flips.
        if (before.stockQty > 0 !== stockQty > 0) {
          await searchOutbox.enqueue([updated._id], { session });
        }
        return updated;
      });
      await invalidate(product); // the cached page shows inStock
      return presentOwn(product);
    },

    /** Public page: active product of an approved shop, otherwise a plain 404. */
    async getPublicBySlug(slug) {
      const key = CACHE.keys.product(slug);
      const cached = await cache.getJson(key);
      if (cached) return cached;

      const product = await Product.findOne({ slug, status: 'active' });
      if (!product) throw notFound(); // misses are not cached: a product can appear any moment
      const shop = await Vendor.findOne({ _id: product.vendorId, status: 'approved' });
      if (!shop) throw notFound();
      const view = presentPublic(product, shop);
      await cache.setJson(key, view, CACHE.ttlSeconds.product);
      return view;
    },
  };
}
