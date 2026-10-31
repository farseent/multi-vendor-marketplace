import { Category } from '../catalog/categories.model.js';
import { Product } from '../catalog/products.model.js';
import { Vendor } from '../shops/shops.model.js';

/** Public rule (DATABASE_SCHEMA): visible only if the product is active AND its shop is approved. */
export const isIndexable = (product, shop) =>
  product.status === 'active' && shop?.status === 'approved';

/**
 * Version for external versioning. A product's visibility also depends on its shop, so the shop's
 * updatedAt counts too: suspending then re-approving a shop must produce strictly newer versions
 * than the delete in between. Stale (older) writes are then rejected by Elasticsearch.
 */
const versionOf = (product, shop) =>
  Math.max(product.updatedAt.getTime(), shop?.updatedAt?.getTime() ?? 0);

/** The searchable document: public fields only. */
function toDoc(product, shop, category) {
  const categoryIds = [String(product.categoryId)];
  if (category?.parentId) categoryIds.push(String(category.parentId));
  return {
    title: product.title,
    description: product.description ?? '',
    slug: product.slug,
    categoryIds,
    shopSlug: shop.shopSlug,
    shopName: shop.shopName,
    imageKey: product.images[0]?.key ?? '',
    pricePaise: product.pricePaise,
    ratingAvg: product.ratingAvg,
    ratingCount: product.ratingCount,
    soldCount: product.soldCount,
    inStock: product.stockQty > 0,
    createdAt: product.createdAt,
  };
}

/** Loads the shops and categories a batch of products refers to (two queries, not N). */
async function loadContext(products) {
  const vendorIds = [...new Set(products.map((p) => String(p.vendorId)))];
  const categoryIds = [...new Set(products.map((p) => String(p.categoryId)))];
  const [vendors, categories] = await Promise.all([
    Vendor.find({ _id: { $in: vendorIds } }),
    Category.find({ _id: { $in: categoryIds } }),
  ]);
  return {
    vendorById: new Map(vendors.map((v) => [v.id, v])),
    categoryById: new Map(categories.map((c) => [c.id, c])),
  };
}

/**
 * Current Mongo state -> index/delete operations. Always reads the live product, so the outbox
 * entry only says "look at this product again" and replays are harmless (idempotent).
 */
export async function opsForProducts(products) {
  const { vendorById, categoryById } = await loadContext(products);
  return products.map((product) => {
    const shop = vendorById.get(String(product.vendorId));
    const version = versionOf(product, shop);
    return isIndexable(product, shop)
      ? {
          op: 'index',
          id: product.id,
          version,
          doc: toDoc(product, shop, categoryById.get(String(product.categoryId))),
        }
      : { op: 'delete', id: product.id, version };
  });
}

/** Same, starting from ids. A product that no longer exists is deleted from the index. */
export async function opsForProductIds(productIds) {
  const products = await Product.find({ _id: { $in: productIds } });
  const ops = await opsForProducts(products);
  const found = new Set(products.map((p) => p.id));
  for (const id of productIds) {
    if (!found.has(String(id))) ops.push({ op: 'delete', id: String(id), version: Date.now() });
  }
  return ops;
}