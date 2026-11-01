import { CART } from '../../config/constants.js';
import { AppError } from '../../lib/AppError.js';
import { Product } from '../catalog/products.model.js';
import { Vendor } from '../shops/shops.model.js';
import { Cart } from './cart.model.js';

const unavailable = () => new AppError('CONFLICT', 409, 'This product is not available');
const couponInvalid = (reason) =>
  new AppError('COUPON_INVALID', 422, 'This coupon cannot be applied', { reason });

/**
 * The customer's cart. It stores only product ids and quantities; every read prices the lines
 * from current Mongo data (never the cache or the search index, ARCHITECTURE 4), so the preview
 * is as fresh as the database. Totals follow the order maths: total = subtotal - discount.
 */
export function createCartService({ couponsService, storage = null }) {
  const imageUrl = (key) => (storage ? storage.publicUrl(key) : null);
  const lastSlot = `items.${CART.maxItems - 1}`; // exists only when the cart is full

  /** Reads the cart and turns each stored item into a priced line (see `status`). */
  async function priceLines(cart) {
    const items = cart?.items ?? [];
    if (items.length === 0) return [];

    const products = await Product.find({ _id: { $in: items.map((i) => i.productId) } });
    const productById = new Map(products.map((p) => [p.id, p]));
    const shops = await Vendor.find({
      _id: { $in: [...new Set(products.map((p) => String(p.vendorId)))] },
    });
    const shopById = new Map(shops.map((s) => [s.id, s]));

    return items.map((item) => {
      const product = productById.get(String(item.productId));
      const shop = product && shopById.get(String(product.vendorId));
      const base = { productId: String(item.productId), quantity: item.quantity };

      // Only active products of approved shops can be bought (same rule as the public page).
      if (!product || product.status !== 'active' || shop?.status !== 'approved') {
        return { ...base, status: 'unavailable', title: product?.title ?? null };
      }
      const lineSubtotalPaise = product.pricePaise * item.quantity;
      return {
        ...base,
        status: product.stockQty >= item.quantity ? 'ok' : 'insufficient_stock',
        // Exact stock is shown only when it is the problem (it is at most quantity - 1 <= 9).
        ...(product.stockQty < item.quantity && { available: product.stockQty }),
        slug: product.slug,
        title: product.title,
        imageUrl: product.images[0] ? imageUrl(product.images[0].key) : null,
        shop: { name: shop.shopName, slug: shop.shopSlug },
        vendorId: String(product.vendorId),
        unitPricePaise: product.pricePaise,
        lineSubtotalPaise,
      };
    });
  }

  // Unavailable lines are shown but never priced or counted.
  const counted = (lines) => lines.filter((line) => line.status !== 'unavailable');

  /** The response body for every cart endpoint. `evaluation` is a coupon result or null. */
  function present(cart, lines, evaluation) {
    const priced = counted(lines);
    const subtotalPaise = priced.reduce((sum, line) => sum + line.lineSubtotalPaise, 0);
    const discounts = new Map();
    let coupon = null;
    let couponError = null;

    if (evaluation?.ok) {
      priced.forEach((line, i) => discounts.set(line.productId, evaluation.lineDiscounts[i]));
      coupon = { ...evaluation.coupon, discountPaise: evaluation.discountPaise };
    } else if (evaluation) {
      couponError = { code: cart.couponCode, reason: evaluation.reason };
    }
    const discountPaise = coupon?.discountPaise ?? 0;

    return {
      items: lines.map((line) => {
        // vendorId is internal (only the coupon rules need it); never sent to the client.
        const view = { ...line };
        delete view.vendorId;
        if (line.status === 'unavailable') return view;
        const lineDiscount = discounts.get(line.productId) ?? 0;
        return {
          ...view,
          discountPaise: lineDiscount,
          lineNetPaise: line.lineSubtotalPaise - lineDiscount,
        };
      }),
      itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
      currency: 'INR',
      subtotalPaise,
      discountPaise,
      shippingPaise: 0, // free shipping in the MVP (D18)
      totalPaise: subtotalPaise - discountPaise,
      coupon,
      couponError,
      // True when something in the cart would stop checkout: the UI should ask the user to fix it.
      hasIssues: lines.some((line) => line.status !== 'ok'),
    };
  }

  /** Re-checks the saved coupon (if any) against the current prices. */
  async function evaluateSaved(customerId, cart, lines) {
    if (!cart?.couponCode) return null;
    const priced = counted(lines);
    if (priced.length === 0) return { ok: false, reason: 'empty_cart' };
    return couponsService.evaluateForCart({
      customerId,
      code: cart.couponCode,
      lines: priced,
    });
  }

  async function preview(customerId) {
    const cart = await Cart.findOne({ customerId });
    const lines = await priceLines(cart);
    return present(cart, lines, await evaluateSaved(customerId, cart, lines));
  }

  /**
   * Sets one line to `quantity` using atomic updates, so two quick requests (a double click, two
   * tabs) cannot lose each other's change or push the cart past the item limit.
   */
  async function upsertLine(customerId, productId, quantity) {
    for (let attempt = 0; attempt < 3; attempt++) {
      // 1) The product is already in the cart: change its quantity.
      const existing = await Cart.updateOne(
        { customerId, 'items.productId': productId },
        { $set: { 'items.$.quantity': quantity } },
      );
      if (existing.matchedCount) return;

      // 2) New product: add it if the product is not there yet and the cart has room. The upsert
      //    also creates the cart on first use. If the cart exists but the filter did not match
      //    (full, or another request added this product a moment ago) the upsert hits the unique
      //    customerId index and throws 11000: look again.
      try {
        await Cart.updateOne(
          { customerId, 'items.productId': { $ne: productId }, [lastSlot]: { $exists: false } },
          { $push: { items: { productId, quantity, addedAt: new Date() } } },
          { upsert: true },
        );
        return;
      } catch (err) {
        if (err?.code !== 11000) throw err;
        if (await Cart.exists({ customerId, [lastSlot]: { $exists: true } })) {
          if (!(await Cart.exists({ customerId, 'items.productId': productId }))) {
            throw new AppError(
              'CONFLICT',
              409,
              `A cart can hold at most ${CART.maxItems} products`,
            );
          }
        }
      }
    }
    throw new AppError('CONFLICT', 409, 'The cart changed at the same time, please retry');
  }

  return {
    preview,

    /** PUT /cart/items/:productId. quantity 0 removes the line. */
    async setQuantity(customerId, productId, quantity) {
      if (quantity === 0) return this.removeItem(customerId, productId);

      const product = await Product.findOne({ _id: productId, status: 'active' });
      const shop = product && (await Vendor.findOne({ _id: product.vendorId, status: 'approved' }));
      // Missing, draft, archived, suspended or unapproved-shop products all look the same, so
      // nobody can probe which ids exist.
      if (!product || !shop) throw unavailable();
      if (product.stockQty < quantity) {
        throw new AppError(
          'OUT_OF_STOCK',
          409,
          `Only ${product.stockQty} of "${product.title}" in stock`,
          [{ productId: product.id, available: product.stockQty }],
        );
      }
      await upsertLine(customerId, product._id, quantity);
      return preview(customerId);
    },

    /** DELETE /cart/items/:productId. Idempotent. Works for unavailable products too. */
    async removeItem(customerId, productId) {
      await Cart.updateOne({ customerId }, { $pull: { items: { productId } } });
      return preview(customerId);
    },

    /** DELETE /cart. */
    async clear(customerId) {
      await Cart.deleteOne({ customerId });
      return preview(customerId);
    },

    /** POST /cart/coupon: validates against the current cart; only a valid code is saved. */
    async applyCoupon(customerId, code) {
      const cart = await Cart.findOne({ customerId });
      const lines = await priceLines(cart);
      const priced = counted(lines);
      if (priced.length === 0) throw couponInvalid('empty_cart');

      const evaluation = await couponsService.evaluateForCart({ customerId, code, lines: priced });
      if (!evaluation.ok) throw couponInvalid(evaluation.reason);

      await Cart.updateOne({ customerId }, { $set: { couponCode: code } });
      return present({ couponCode: code }, lines, evaluation);
    },

    /** DELETE /cart/coupon. Idempotent. */
    async removeCoupon(customerId) {
      await Cart.updateOne({ customerId }, { $unset: { couponCode: 1 } });
      return preview(customerId);
    },
  };
}
