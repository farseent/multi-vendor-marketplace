import { Category } from '../catalog/categories.model.js';
import { Product } from '../catalog/products.model.js';
import { Vendor } from '../shops/shops.model.js';
import { skipFor } from '../../lib/pagination.js';

const SORTS = {
  price: { pricePaise: 1, slug: 1 },
  '-price': { pricePaise: -1, slug: 1 },
  '-createdAt': { createdAt: -1, slug: 1 },
  '-ratingAvg': { ratingAvg: -1, ratingCount: -1, slug: 1 },
};

/**
 * Reduced-feature search straight from Mongo (D12), used when Elasticsearch is down or not
 * configured. Same filters and sorts, but plain `$text` matching: no fuzziness, no field
 * boosting. Returns the same item shape as the Elasticsearch path.
 */
export async function mongoSearch(params, { imageUrl }) {
  const { q, categoryId, vendor, minPrice, maxPrice, minRating, inStock, sort, page, limit } =
    params;

  // Only approved shops are public; resolve them first (Product has no embedded shop data).
  const shops = await Vendor.find({
    status: 'approved',
    ...(vendor && { shopSlug: vendor }),
  });
  if (shops.length === 0) return { items: [], total: 0 };
  const shopById = new Map(shops.map((s) => [s.id, s]));

  const filter = {
    status: 'active',
    vendorId: { $in: shops.map((s) => s._id) },
  };
  if (categoryId) {
    // A parent category also matches its children, like categoryIds does in the index.
    const children = await Category.find({ parentId: categoryId }, { _id: 1 });
    filter.categoryId = { $in: [categoryId, ...children.map((c) => c._id)] };
  }
  if (minPrice !== undefined || maxPrice !== undefined) {
    filter.pricePaise = {
      ...(minPrice !== undefined && { $gte: minPrice }),
      ...(maxPrice !== undefined && { $lte: maxPrice }),
    };
  }
  if (minRating !== undefined) filter.ratingAvg = { $gte: minRating };
  if (inStock) filter.stockQty = { $gt: 0 };
  if (q) filter.$text = { $search: q };

  const byScore = q && sort === 'relevance';
  const order = byScore
    ? { score: { $meta: 'textScore' }, slug: 1 }
    : (SORTS[sort] ?? SORTS['-createdAt']);

  const [products, total] = await Promise.all([
    Product.find(filter, byScore ? { score: { $meta: 'textScore' } } : undefined)
      .sort(order)
      .skip(skipFor({ page, limit }))
      .limit(limit),
    Product.countDocuments(filter),
  ]);

  const items = products.map((p) => {
    const shop = shopById.get(String(p.vendorId));
    return {
      id: p.id,
      slug: p.slug,
      title: p.title,
      pricePaise: p.pricePaise,
      imageUrl: imageUrl(p.images[0]?.key),
      ratingAvg: p.ratingAvg,
      ratingCount: p.ratingCount,
      shop: { name: shop.shopName, slug: shop.shopSlug },
      inStock: p.stockQty > 0,
    };
  });
  return { items, total };
}