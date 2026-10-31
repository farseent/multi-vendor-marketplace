import { rupeesToPaise } from './money.js';

export const SORT_OPTIONS = [
  { value: 'relevance', label: 'Best match' },
  { value: 'price', label: 'Price: low to high' },
  { value: '-price', label: 'Price: high to low' },
  { value: '-createdAt', label: 'Newest' },
  { value: '-ratingAvg', label: 'Top rated' },
];
const SORT_VALUES = SORT_OPTIONS.map((o) => o.value);

/**
 * The page URL is the single source of truth for the filters (shareable, back-button friendly).
 * Prices are written in rupees there ("min=500") because people read and edit that URL; they are
 * converted to integer paise only when the API request is built.
 */
export function readFilters(params) {
  const page = Number.parseInt(params.get('page') ?? '', 10);
  return {
    q: (params.get('q') ?? '').trim(),
    category: params.get('category') ?? '',
    min: params.get('min') ?? '',
    max: params.get('max') ?? '',
    inStock: params.get('inStock') === '1',
    sort: SORT_VALUES.includes(params.get('sort')) ? params.get('sort') : 'relevance',
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** Filters -> URL parameters, leaving out everything that is at its default. */
export function toUrlParams(filters) {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.category) params.set('category', filters.category);
  if (filters.min) params.set('min', filters.min);
  if (filters.max) params.set('max', filters.max);
  if (filters.inStock) params.set('inStock', '1');
  if (filters.sort !== 'relevance') params.set('sort', filters.sort);
  if (filters.page > 1) params.set('page', String(filters.page));
  return params;
}

/** Filters -> GET /products/search query string. A price that is not a valid amount is dropped. */
export function toApiQuery(filters, limit = 20) {
  const params = new URLSearchParams({
    sort: filters.sort,
    page: String(filters.page),
    limit: String(limit),
  });
  if (filters.q) params.set('q', filters.q);
  if (filters.category) params.set('categoryId', filters.category);
  const min = rupeesToPaise(filters.min);
  const max = rupeesToPaise(filters.max);
  if (min !== null) params.set('minPrice', String(min));
  if (max !== null) params.set('maxPrice', String(max));
  if (filters.inStock) params.set('inStock', 'true');
  return params.toString();
}

/** Category tree -> flat options, children indented under their parent. */
export function flattenCategories(tree) {
  return tree.flatMap((c) => [
    { id: c.id, label: c.name },
    ...(c.children ?? []).map((child) => ({
      id: child.id,
      label: `— ${child.name}`,
    })),
  ]);
}