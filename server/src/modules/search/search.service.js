import { createHash } from 'node:crypto';
import { CACHE } from '../../config/constants.js';
import { pageMeta } from '../../lib/pagination.js';
import { mongoSearch } from './search.fallback.js';

// Same keys + values -> same hash, regardless of the order the client sent the parameters in.
const hashParams = (params) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        Object.entries(params)
          .filter(([, v]) => v !== undefined)
          .sort(),
      ),
    )
    .digest('hex')
    .slice(0, 32);

export function createSearchService({ searchIndex = null, cache, storage = null, logger }) {
  const imageUrl = (key) => (key && storage ? storage.publicUrl(key) : null);

  const fromHit = (hit) => ({
    id: hit.id,
    slug: hit.slug,
    title: hit.title,
    pricePaise: hit.pricePaise,
    imageUrl: imageUrl(hit.imageKey),
    ratingAvg: hit.ratingAvg,
    ratingCount: hit.ratingCount,
    shop: { name: hit.shopName, slug: hit.shopSlug },
    inStock: hit.inStock,
  });

  return {
    /**
     * Returns { items, meta, fallback }. Order: Redis (60 s) -> Elasticsearch -> Mongo fallback.
     * Fallback answers are never cached, so they cannot outlive the outage that caused them.
     */
    async search(params) {
      const key = CACHE.keys.search(hashParams(params));
      const cached = await cache.getJson(key);
      if (cached) return { ...cached, fallback: false };

      const paging = { page: params.page, limit: params.limit };
      if (searchIndex) {
        try {
          const { items, total } = await searchIndex.search(params);
          const result = {
            items: items.map(fromHit),
            meta: pageMeta(paging, total),
          };
          await cache.setJson(key, result, CACHE.ttlSeconds.search);
          return { ...result, fallback: false };
        } catch (err) {
          logger.warn({ err: err.message }, 'Elasticsearch search failed, using Mongo fallback');
        }
      }
      const { items, total } = await mongoSearch(params, { imageUrl });
      return { items, meta: pageMeta(paging, total), fallback: true };
    },
  };
}