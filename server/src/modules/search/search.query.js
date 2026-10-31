import { skipFor } from '../../lib/pagination.js';

const RESULT_FIELDS = [
  'title',
  'slug',
  'pricePaise',
  'imageKey',
  'ratingAvg',
  'ratingCount',
  'shopName',
  'shopSlug',
  'inStock',
];

// Tie-breaker: slug is unique per product, so pages never overlap or skip when scores are equal.
const TIE = { slug: 'asc' };

function buildSort(sort, hasQuery) {
  switch (sort) {
    case 'price':
      return [{ pricePaise: 'asc' }, TIE];
    case '-price':
      return [{ pricePaise: 'desc' }, TIE];
    case '-ratingAvg':
      return [{ ratingAvg: 'desc' }, { ratingCount: 'desc' }, TIE];
    case '-createdAt':
      return [{ createdAt: 'desc' }, TIE];
    default: // relevance: by score when there is a text query, otherwise newest first
      return hasQuery
        ? [{ _score: 'desc' }, { createdAt: 'desc' }, TIE]
        : [{ createdAt: 'desc' }, TIE];
  }
}

/**
 * Pure function: validated search params -> Elasticsearch request body.
 * The index only holds active products of approved shops, so no status filter is needed here.
 */
export function buildEsRequest(params) {
  const { q, categoryId, vendor, minPrice, maxPrice, minRating, inStock, sort, page, limit } =
    params;

  const must = q
    ? [
        {
          multi_match: {
            query: q,
            fields: ['title^3', 'description'],
            fuzziness: 'AUTO',
            operator: 'and',
          },
        },
      ]
    : [{ match_all: {} }];

  const filter = [];
  if (categoryId) filter.push({ term: { categoryIds: categoryId } });
  if (vendor) filter.push({ term: { shopSlug: vendor } });
  if (minPrice !== undefined || maxPrice !== undefined) {
    filter.push({
      range: {
        pricePaise: {
          ...(minPrice !== undefined && { gte: minPrice }),
          ...(maxPrice !== undefined && { lte: maxPrice }),
        },
      },
    });
  }
  if (minRating !== undefined) filter.push({ range: { ratingAvg: { gte: minRating } } });
  if (inStock) filter.push({ term: { inStock: true } });

  return {
    from: skipFor({ page, limit }),
    size: limit,
    track_total_hits: true,
    _source: RESULT_FIELDS,
    query: { bool: { must, filter } },
    sort: buildSort(sort, Boolean(q)),
  };
}