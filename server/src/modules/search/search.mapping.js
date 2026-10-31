import { SEARCH } from '../../config/constants.js';

/**
 * Index mapping. `dynamic: strict` means a typo in a document field fails loudly instead of
 * silently creating a new field. Only PUBLIC fields are indexed (no stockQty, sku, vendorId).
 */
export const productIndexBody = {
  settings: { number_of_shards: 1, number_of_replicas: SEARCH.replicas },
  mappings: {
    dynamic: 'strict',
    properties: {
      title: { type: 'text' },
      description: { type: 'text' },
      slug: { type: 'keyword' },
      categoryIds: { type: 'keyword' }, // the product's category and its parent, for filtering
      shopSlug: { type: 'keyword' },
      shopName: { type: 'keyword', index: false },
      imageKey: { type: 'keyword', index: false },
      pricePaise: { type: 'long' },
      ratingAvg: { type: 'float' },
      ratingCount: { type: 'integer' },
      soldCount: { type: 'integer' },
      inStock: { type: 'boolean' },
      createdAt: { type: 'date' },
    },
  },
};