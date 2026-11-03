import mongoose from 'mongoose';
import { CACHE, REVIEW } from '../../config/constants.js';
import { AppError } from '../../lib/AppError.js';
import { pageMeta, skipFor } from '../../lib/pagination.js';
import { publicName, ratingSummary } from '../../lib/ratings.js';
import { Product } from '../catalog/products.model.js';
import { SubOrder } from '../orders/orders.model.js';
import { Vendor } from '../shops/shops.model.js';
import { User } from '../users/users.model.js';
import { Review } from './reviews.model.js';

const inTransaction = (work) => mongoose.connection.transaction(work);
const DAY_MS = 24 * 60 * 60 * 1000;

const notFound = (what = 'Review') => new AppError('NOT_FOUND', 404, `${what} not found`);
const SORTS = {
  '-createdAt': { createdAt: -1, _id: -1 },
  createdAt: { createdAt: 1, _id: 1 },
  '-rating': { rating: -1, createdAt: -1, _id: -1 },
  rating: { rating: 1, createdAt: -1, _id: -1 },
};

/**
 * Reviews (D61, D62). Rules enforced here, in the service layer:
 *  - only a customer with a `delivered` sub-order that contains the product may review it (403);
 *  - one review per customer per product (409 REVIEW_EXISTS; the unique index decides races);
 *  - the owner may edit or delete for 30 days; other customers' reviews are a plain 404;
 *  - every change that can move the average (create, rating edit, delete, hide/publish)
 *    recomputes `ratingAvg/ratingCount` from the published reviews IN THE SAME TRANSACTION, then
 *    drops the cached product page and queues a search re-index.
 */
export function createReviewsService({ audit, cache, searchOutbox }) {
  const editableUntil = (review) =>
    new Date(review.createdAt.getTime() + REVIEW.editWindowDays * DAY_MS);

  // The owner's own view (includes status, so a hidden review is not a mystery to its author).
  const presentOwn = (review) => ({
    id: review.id,
    productId: String(review.productId),
    rating: review.rating,
    title: review.title ?? null,
    body: review.body,
    status: review.status,
    editableUntil: editableUntil(review),
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
  });

  // Public view: explicit allow-list, no customer id, no sub-order id, first name + initial only.
  const presentPublic = (review, authorName) => ({
    id: review.id,
    rating: review.rating,
    title: review.title ?? null,
    body: review.body,
    authorName,
    verifiedPurchase: true, // a review can only exist with a delivered sub-order (D61)
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
  });

  /** The delivered sub-order that makes `customerId` eligible to review `productId`, or null. */
  const findPurchase = (customerId, productId) =>
    SubOrder.findOne({
      customerId,
      fulfillmentStatus: 'delivered',
      'items.productId': productId,
    }).sort({ deliveredAt: -1 });

  /**
   * Recomputes a product's average from its published reviews and stores it. Runs inside the
   * caller's transaction: two concurrent writers both update the same product document, so Mongo
   * makes one of them retry with a fresh snapshot, and the last committed average is always
   * computed from every committed review. Returns the product's slug (for the cache).
   */
  async function recomputeRating(productId, { session }) {
    const [row] = await Review.aggregate([
      {
        $match: { productId: new mongoose.Types.ObjectId(String(productId)), status: 'published' },
      },
      { $group: { _id: null, sum: { $sum: '$rating' }, count: { $sum: 1 } } },
    ]).session(session);
    const product = await Product.findOneAndUpdate(
      { _id: productId },
      { $set: ratingSummary(row?.sum ?? 0, row?.count ?? 0) },
      { session, returnDocument: 'after', projection: { slug: 1 } },
    );
    await searchOutbox.enqueue([productId], { session }); // the search index holds ratingAvg
    return product?.slug ?? null;
  }

  const dropCachedProduct = (slug) => (slug ? cache.del(CACHE.keys.product(slug)) : undefined);

  /** Loads the caller's own review and enforces the 30-day window (404 / 409). */
  async function loadEditable(customerId, reviewId) {
    const review = await Review.findOne({ _id: reviewId, customerId });
    if (!review) throw notFound();
    if (Date.now() > editableUntil(review).getTime()) {
      throw new AppError('CONFLICT', 409, 'This review can no longer be changed', {
        reason: 'edit_window_closed',
      });
    }
    return review;
  }

  return {
    async create(customerId, productId, input) {
      const product = await Product.findById(productId);
      if (!product) throw notFound('Product');

      const purchase = await findPurchase(customerId, product._id);
      if (!purchase) {
        throw new AppError('FORBIDDEN', 403, 'Only customers with a delivered order can review', {
          reason: 'no_delivered_purchase',
        });
      }
      const exists = () =>
        new AppError('REVIEW_EXISTS', 409, 'You have already reviewed this product');
      if (await Review.exists({ customerId, productId: product._id })) throw exists();

      let slug;
      let review;
      try {
        review = await inTransaction(async (session) => {
          const [created] = await Review.create(
            [
              {
                productId: product._id,
                vendorId: product.vendorId,
                customerId,
                subOrderId: purchase._id,
                rating: input.rating,
                title: input.title,
                body: input.body,
              },
            ],
            { session },
          );
          slug = await recomputeRating(product._id, { session });
          return created;
        });
      } catch (err) {
        if (err?.code === 11000) throw exists(); // lost a race with the same customer's other request
        throw err;
      }
      await dropCachedProduct(slug);
      return presentOwn(review);
    },

    async update(customerId, reviewId, patch) {
      const current = await loadEditable(customerId, reviewId);
      const $set = {};
      const $unset = {};
      if (patch.rating !== undefined) $set.rating = patch.rating;
      if (patch.body !== undefined) $set.body = patch.body;
      if (patch.title === null) $unset.title = 1;
      else if (patch.title !== undefined) $set.title = patch.title;
      const update = {
        ...(Object.keys($set).length && { $set }),
        ...(Object.keys($unset).length && { $unset }),
      };

      let slug = null;
      const review = await inTransaction(async (session) => {
        const updated = await Review.findOneAndUpdate({ _id: current._id, customerId }, update, {
          session,
          returnDocument: 'after',
          runValidators: true,
        });
        if (!updated) throw notFound();
        // Only a changed rating of a visible review can move the average.
        if (patch.rating !== undefined && updated.status === 'published') {
          slug = await recomputeRating(updated.productId, { session });
        }
        return updated;
      });
      await dropCachedProduct(slug);
      return presentOwn(review);
    },

    async remove(customerId, reviewId) {
      const current = await loadEditable(customerId, reviewId);
      let slug = null;
      await inTransaction(async (session) => {
        const removed = await Review.findOneAndDelete(
          { _id: current._id, customerId },
          { session },
        );
        if (!removed) throw notFound();
        if (removed.status === 'published') {
          slug = await recomputeRating(removed.productId, { session });
        }
      });
      await dropCachedProduct(slug);
      return { id: String(current._id), deleted: true };
    },

    /** Admin moderation (hide/publish). Repeating the current status changes and audits nothing. */
    async setStatus(actor, reviewId, status) {
      let slug = null;
      const result = await inTransaction(async (session) => {
        const before = await Review.findOneAndUpdate(
          { _id: reviewId, status: { $ne: status } },
          { $set: { status } },
          { session, returnDocument: 'before' },
        );
        if (!before) {
          const same = await Review.findById(reviewId).session(session);
          if (!same) throw notFound();
          return { id: same.id, productId: String(same.productId), status, changed: false };
        }
        slug = await recomputeRating(before.productId, { session });
        await audit.record(
          actor,
          {
            action: 'review.status_changed',
            entityType: 'review',
            entityId: before._id,
            meta: { from: before.status, to: status, productId: String(before.productId) },
          },
          { session },
        );
        return { id: before.id, productId: String(before.productId), status, changed: true };
      });
      await dropCachedProduct(slug);
      return result;
    },

    /** Public list: published reviews of a product that is on sale. */
    async listPublic(productId, { page, limit, sort }) {
      const product = await Product.findOne({ _id: productId, status: 'active' });
      const shop = product && (await Vendor.findOne({ _id: product.vendorId, status: 'approved' }));
      if (!product || !shop) throw notFound('Product');

      const filter = { productId: product._id, status: 'published' };
      const [reviews, total] = await Promise.all([
        Review.find(filter).sort(SORTS[sort]).skip(skipFor({ page, limit })).limit(limit),
        Review.countDocuments(filter),
      ]);
      const authors = await User.find(
        { _id: { $in: reviews.map((r) => r.customerId) } },
        { name: 1 },
      );
      const nameById = new Map(authors.map((u) => [u.id, publicName(u.name)]));
      return {
        items: reviews.map((r) =>
          presentPublic(r, nameById.get(String(r.customerId)) ?? 'Customer'),
        ),
        meta: pageMeta({ page, limit }, total),
      };
    },

    /** What the product page needs to decide whether to show the form: purchase + own review. */
    async mine(customerId, productId) {
      const product = await Product.findById(productId, { _id: 1 });
      if (!product) throw notFound('Product');
      const [purchase, review] = await Promise.all([
        findPurchase(customerId, product._id),
        Review.findOne({ customerId, productId: product._id }),
      ]);
      return { eligible: Boolean(purchase), review: review ? presentOwn(review) : null };
    },
  };
}
