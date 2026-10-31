import { z } from 'zod';
import { SEARCH, SEARCH_SORTS } from '../../config/constants.js';
import { objectId, paginationQuery } from '../../lib/pagination.js';

// "?minPrice=" arrives as an empty string; treat it as "not given" (z.coerce would make it 0).
const optional = (schema) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const paise = z.coerce.number().int().min(0).max(1_000_000_000);

/** GET /products/search query. Prices are integer paise, like everywhere else in the API. */
export const searchQuery = z
  .object({
    q: optional(z.string().trim().max(SEARCH.maxQueryLength)).transform((v) => v || undefined),
    categoryId: optional(objectId('category id').transform((v) => v.toLowerCase())),
    vendor: optional(
      z
        .string()
        .toLowerCase()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid shop slug')
        .max(100),
    ),
    minPrice: optional(paise),
    maxPrice: optional(paise),
    minRating: optional(z.coerce.number().min(0).max(5)),
    inStock: optional(z.enum(['true', 'false']).transform((v) => v === 'true')),
    sort: z.enum(SEARCH_SORTS).default('relevance'),
    ...paginationQuery,
  })
  .refine((v) => v.minPrice === undefined || v.maxPrice === undefined || v.minPrice <= v.maxPrice, {
    path: ['minPrice'],
    message: 'minPrice must not exceed maxPrice',
  })
  .refine((v) => v.page * v.limit <= SEARCH.maxResultWindow, {
    path: ['page'],
    message: `page x limit must not exceed ${SEARCH.maxResultWindow}`,
  });