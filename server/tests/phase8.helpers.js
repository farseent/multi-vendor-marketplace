import mongoose from 'mongoose';
import { mulDivRoundHalfUp } from '../src/lib/money.js';
import { Order, SubOrder } from '../src/modules/orders/orders.model.js';
import { Refund } from '../src/modules/refunds/refunds.model.js';

export const DAY = 86_400_000;

/** Small seeded random numbers (mulberry32): the same seed always builds the same fixtures. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const oid = () => new mongoose.Types.ObjectId();

/**
 * Builds plain order / sub-order / refund documents for the analytics tests. Nothing is stored
 * here; `insertFixtures` does that, and `expected*` recompute the answers from the same objects
 * with plain loops, so the tests compare the Mongo pipelines with an independent calculation.
 *
 * About 90% of orders are paid; the rest are unpaid or failed (never counted). Paid orders may
 * have one sub-order cancelled and fully refunded, or a partial refund (with its Refund row).
 * `startMs` + `days` is the span the placement times are spread over.
 */
export function buildFixtures({
  orders: count,
  vendors = 8,
  products = 40,
  startMs,
  days,
  seed = 7,
}) {
  const random = rng(seed);
  const pick = (n) => Math.floor(random() * n);
  const vendorIds = Array.from({ length: vendors }, oid);
  const catalog = Array.from({ length: products }, (_, i) => ({
    productId: oid(),
    title: `Product ${String(i).padStart(3, '0')}`,
    sku: `SKU-${i}`,
    vendorId: vendorIds[i % vendors],
    unitPricePaise: 100 + pick(99_900),
  }));
  const byVendor = vendorIds.map((id) => catalog.filter((p) => p.vendorId === id));

  const orders = [];
  const subOrders = [];
  const refunds = [];
  for (let n = 1; n <= count; n++) {
    const orderId = oid();
    const customerId = oid();
    const roll = random();
    const paymentStatus = roll < 0.9 ? 'paid' : roll < 0.95 ? 'unpaid' : 'failed';
    const placedAt = new Date(startMs + Math.floor(random() * days * DAY));
    const orderNumber = `MP-20260901-${String(n).padStart(6, '0')}`;

    const subCount = 1 + pick(3);
    const vendorPick = new Set();
    while (vendorPick.size < Math.min(subCount, vendors)) vendorPick.add(pick(vendors));
    let orderTotal = 0;
    let orderRefunded = 0;
    let s = 0;
    for (const v of vendorPick) {
      s += 1;
      const rateBps = [500, 800, 1000, 1250][pick(4)];
      const items = Array.from({ length: 1 + pick(3) }, () => {
        const product = byVendor[v][pick(byVendor[v].length)];
        const quantity = 1 + pick(4);
        const lineSubtotalPaise = product.unitPricePaise * quantity;
        const discountPaise = random() < 0.2 ? pick(Math.floor(lineSubtotalPaise / 4) + 1) : 0;
        return {
          productId: product.productId,
          title: product.title,
          sku: product.sku,
          unitPricePaise: product.unitPricePaise,
          quantity,
          lineSubtotalPaise,
          discountPaise,
          lineNetPaise: lineSubtotalPaise - discountPaise,
        };
      });
      const subtotalPaise = items.reduce((n2, i) => n2 + i.lineSubtotalPaise, 0);
      const discountPaise = items.reduce((n2, i) => n2 + i.discountPaise, 0);
      const customerTotalPaise = subtotalPaise - discountPaise;
      const commissionPaise = mulDivRoundHalfUp(customerTotalPaise, rateBps, 10_000);
      const cancelled = paymentStatus === 'paid' && random() < 0.08;
      const partial = paymentStatus === 'paid' && !cancelled && random() < 0.1;
      const refundedPaise = cancelled
        ? customerTotalPaise
        : partial
          ? 1 + pick(customerTotalPaise - 1)
          : 0;
      const subOrderId = oid();
      subOrders.push({
        _id: subOrderId,
        subOrderNumber: `${orderNumber}-V${s}`,
        orderId,
        customerId,
        vendorId: vendorIds[v],
        items,
        subtotalPaise,
        discountPaise,
        shippingPaise: 0,
        customerTotalPaise,
        commission: {
          rateBps,
          rateSource: 'platform',
          amountPaise: commissionPaise,
          basePaise: customerTotalPaise,
        },
        vendorPayoutPaise: customerTotalPaise - commissionPaise,
        fulfillmentStatus: cancelled
          ? 'cancelled'
          : paymentStatus === 'paid'
            ? ['processing', 'shipped', 'delivered'][pick(3)]
            : 'pending_payment',
        refundStatus:
          refundedPaise === 0 ? 'none' : refundedPaise === customerTotalPaise ? 'full' : 'partial',
        refundedPaise,
        stockRestored: false,
        statusHistory: [],
        createdAt: placedAt,
        updatedAt: placedAt,
      });
      if (refundedPaise > 0) {
        const commissionReversedPaise = Math.min(
          refundedPaise,
          mulDivRoundHalfUp(refundedPaise, commissionPaise, customerTotalPaise),
        );
        refunds.push({
          _id: oid(),
          paymentId: oid(),
          orderId,
          subOrderId,
          amountPaise: refundedPaise,
          commissionReversedPaise,
          vendorDebitPaise: refundedPaise - commissionReversedPaise,
          reason: cancelled ? 'customer_cancel' : 'admin',
          status: ['processed', 'initiated'][pick(2)],
          idempotencyKey: `seed-refund-${n}-${s}`,
          createdAt: placedAt,
          updatedAt: placedAt,
        });
        // A failed refund reversed nothing; it must not change any total.
        refunds.push({
          _id: oid(),
          paymentId: oid(),
          orderId,
          subOrderId,
          amountPaise: 100,
          commissionReversedPaise: 10,
          vendorDebitPaise: 90,
          reason: 'admin',
          status: 'failed',
          idempotencyKey: `seed-refund-failed-${n}-${s}`,
          createdAt: placedAt,
          updatedAt: placedAt,
        });
      }
      orderTotal += customerTotalPaise;
      orderRefunded += refundedPaise;
    }
    orders.push({
      _id: orderId,
      orderNumber,
      customerId,
      status: paymentStatus === 'paid' ? 'placed' : 'pending_payment',
      paymentStatus,
      refundStatus:
        orderRefunded === 0 ? 'none' : orderRefunded === orderTotal ? 'full' : 'partial',
      currency: 'INR',
      subtotalPaise: orderTotal,
      discountPaise: 0,
      shippingPaise: 0,
      totalPaise: orderTotal,
      idempotencyKey: `seed-order-${n}`,
      placedAt: paymentStatus === 'paid' ? placedAt : undefined,
      createdAt: placedAt,
      updatedAt: placedAt,
    });
  }
  return { vendorIds, orders, subOrders, refunds };
}

/** Writes fixtures straight to the collections (no validation, no timestamps added). */
export async function insertFixtures(fx) {
  const chunk = async (model, docs) => {
    for (let i = 0; i < docs.length; i += 2000) {
      await model.collection.insertMany(docs.slice(i, i + 2000));
    }
  };
  await chunk(Order, fx.orders);
  await chunk(SubOrder, fx.subOrders);
  await chunk(Refund, fx.refunds);
}

const inRange = (o, { fromMs, toMs }) =>
  o.paymentStatus === 'paid' && o.placedAt.getTime() >= fromMs && o.placedAt.getTime() < toMs;

/** The overview answer recomputed from the fixtures with plain loops. */
export function expectedOverview(fx, range) {
  const orders = fx.orders.filter((o) => inRange(o, range));
  const ids = new Set(orders.map((o) => String(o._id)));
  const subs = fx.subOrders.filter((s) => ids.has(String(s.orderId)));
  const refunds = fx.refunds.filter(
    (r) => ids.has(String(r.orderId)) && ['initiated', 'processed'].includes(r.status),
  );
  const sum = (list, f) => list.reduce((n, x) => n + f(x), 0);
  const gmvPaise = sum(orders, (o) => o.totalPaise);
  const refundedPaise = sum(subs, (s) => s.refundedPaise);
  const commissionPaise = sum(subs, (s) => s.commission.amountPaise);
  const commissionReversedPaise = sum(refunds, (r) => r.commissionReversedPaise);
  return {
    orderCount: orders.length,
    subOrderCount: subs.length,
    gmvPaise,
    refundedPaise,
    netGmvPaise: gmvPaise - refundedPaise,
    commissionPaise,
    commissionReversedPaise,
    netCommissionPaise: commissionPaise - commissionReversedPaise,
    averageOrderValuePaise: orders.length ? mulDivRoundHalfUp(gmvPaise, 1, orders.length) : 0,
  };
}

/** Per-vendor and per-product totals, recomputed (same rules as the endpoints). */
export function expectedLeaders(fx, range) {
  const orders = fx.orders.filter((o) => inRange(o, range));
  const ids = new Set(orders.map((o) => String(o._id)));
  const subs = fx.subOrders.filter((s) => ids.has(String(s.orderId)));
  const vendors = new Map();
  const products = new Map();
  for (const s of subs) {
    const v = vendors.get(String(s.vendorId)) ?? {
      vendorId: String(s.vendorId),
      subOrderCount: 0,
      gmvPaise: 0,
      refundedPaise: 0,
      commissionPaise: 0,
    };
    v.subOrderCount += 1;
    v.gmvPaise += s.customerTotalPaise;
    v.refundedPaise += s.refundedPaise;
    v.commissionPaise += s.commission.amountPaise;
    vendors.set(v.vendorId, v);
    if (s.fulfillmentStatus === 'cancelled') continue;
    for (const i of s.items) {
      const p = products.get(String(i.productId)) ?? {
        productId: String(i.productId),
        title: i.title,
        unitsSold: 0,
        revenuePaise: 0,
      };
      p.unitsSold += i.quantity;
      p.revenuePaise += i.lineNetPaise;
      products.set(p.productId, p);
    }
  }
  const rank = (map, key) =>
    [...map.values()].sort(
      (a, b) =>
        b[key] - a[key] || (a.vendorId ?? a.productId).localeCompare(b.vendorId ?? b.productId),
    );
  return { vendors: rank(vendors, 'gmvPaise'), products: rank(products, 'revenuePaise') };
}

/** Day buckets (UTC) recomputed from the fixtures. */
export function expectedByDay(fx, range) {
  const out = new Map();
  for (const o of fx.orders.filter((x) => inRange(x, range))) {
    const day = o.placedAt.toISOString().slice(0, 10);
    const row = out.get(day) ?? { orderCount: 0, gmvPaise: 0 };
    row.orderCount += 1;
    row.gmvPaise += o.totalPaise;
    out.set(day, row);
  }
  return out;
}
