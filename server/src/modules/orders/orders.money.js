import { computeSubOrderMoney, resolveCommissionRate } from '../../lib/commission.js';

/**
 * Splits a priced cart into sub-orders (one per vendor) and works out every amount (D3, D6).
 * Pure: the checkout service reads the data and calls this inside its transaction; the property
 * tests call it with random carts.
 *
 * lines: [{ productId, vendorId, categoryId, title, sku, imageKey, unitPricePaise, quantity }]
 *   (ids are strings; the order of `lines` is the order of `evaluation.lineDiscounts`)
 * evaluation: { discountPaise, lineDiscounts } from evaluateCoupon, or null for no coupon
 * fundedBy: 'vendor' | 'platform' (only used when there is a discount)
 * vendorBpsById: Map vendorId -> commissionRateBps | null
 * categoryBpsById: Map categoryId -> defaultCommissionBps | null
 */
export function buildOrderDraft({
  lines,
  evaluation,
  fundedBy,
  platformBps,
  vendorBpsById,
  categoryBpsById,
}) {
  const discounts = evaluation?.lineDiscounts ?? lines.map(() => 0);
  const byVendor = new Map();
  lines.forEach((line, i) => {
    const lineSubtotalPaise = line.unitPricePaise * line.quantity;
    const discountPaise = discounts[i];
    const item = {
      productId: line.productId,
      title: line.title,
      sku: line.sku,
      imageKey: line.imageKey,
      unitPricePaise: line.unitPricePaise,
      quantity: line.quantity,
      lineSubtotalPaise,
      discountPaise,
      lineNetPaise: lineSubtotalPaise - discountPaise,
    };
    const group = byVendor.get(line.vendorId) ?? { vendorId: line.vendorId, items: [], cats: [] };
    group.items.push(item);
    group.cats.push(categoryBpsById.get(line.categoryId) ?? null);
    byVendor.set(line.vendorId, group);
  });

  // Sorted by vendor id so the V1, V2... numbering is deterministic.
  const subOrders = [...byVendor.values()]
    .sort((a, b) => (a.vendorId < b.vendorId ? -1 : a.vendorId > b.vendorId ? 1 : 0))
    .map((group) => {
      const subtotalPaise = group.items.reduce((sum, item) => sum + item.lineSubtotalPaise, 0);
      const discountPaise = group.items.reduce((sum, item) => sum + item.discountPaise, 0);
      const { rateBps, rateSource } = resolveCommissionRate({
        vendorBps: vendorBpsById.get(group.vendorId) ?? null,
        categoryBps: group.cats,
        platformBps,
      });
      const money = computeSubOrderMoney({ subtotalPaise, discountPaise, fundedBy, rateBps });
      return {
        vendorId: group.vendorId,
        items: group.items,
        subtotalPaise,
        discountPaise,
        shippingPaise: 0, // free shipping in the MVP (D18)
        customerTotalPaise: money.customerTotalPaise,
        commission: {
          rateBps,
          rateSource,
          amountPaise: money.commissionPaise,
          basePaise: money.basePaise,
        },
        vendorPayoutPaise: money.vendorPayoutPaise,
      };
    });

  const subtotalPaise = subOrders.reduce((sum, so) => sum + so.subtotalPaise, 0);
  const discountPaise = subOrders.reduce((sum, so) => sum + so.discountPaise, 0);
  const totalPaise = subOrders.reduce((sum, so) => sum + so.customerTotalPaise, 0);
  return { subOrders, subtotalPaise, discountPaise, shippingPaise: 0, totalPaise };
}
