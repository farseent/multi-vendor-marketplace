import { Product } from '../catalog/products.model.js';
import { SearchOutbox } from './search.model.js';

/**
 * Writes outbox entries. Pass the caller's transaction `session` so the entry commits or rolls
 * back together with the product change (that is the whole point of the outbox, D11).
 */
export function createSearchOutbox() {
  return {
    async enqueue(productIds, { session, op = 'upsert' } = {}) {
      const ids = [...new Set(productIds.map(String))];
      if (ids.length === 0) return;
      await SearchOutbox.insertMany(
        ids.map((productId) => ({ productId, op })),
        { session },
      );
    },

    /** Vendor status/name changes affect every product of that shop. Returns their slugs. */
    async enqueueVendorProducts(vendorId, { session } = {}) {
      const products = await Product.find({ vendorId }, { slug: 1 }).session(session ?? null);
      await this.enqueue(
        products.map((p) => p._id),
        { session },
      );
      return products.map((p) => p.slug);
    },
  };
}
