import { createHash } from 'node:crypto';
import { ANALYTICS, CACHE } from '../../config/constants.js';
import { AppError } from '../../lib/AppError.js';
import { mulDivRoundHalfUp } from '../../lib/money.js';
import { Order, SubOrder } from '../orders/orders.model.js';
import { Refund } from '../refunds/refunds.model.js';
import { Vendor } from '../shops/shops.model.js';

const DAY_MS = 86_400_000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The date range of an analytics request, in UTC (D64).
 * `from` and `to` are calendar days, both inclusive. Missing `to` = today; missing `from` = 30
 * days ending at `to`. The range is turned into a half-open interval [from 00:00, to + 1 day
 * 00:00), so it never depends on the time of day the request arrives at: that also keeps the
 * default range, and so the cache key, stable for the whole day.
 */
export function resolveRange({ from, to } = {}, now = new Date()) {
  const parse = (text) => {
    const [y, m, d] = text.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const end = (to ? parse(to) : today) + DAY_MS; // exclusive
  const start = from ? parse(from) : end - ANALYTICS.defaultDays * DAY_MS;
  const days = Math.round((end - start) / DAY_MS);
  if (days < 1 || days > ANALYTICS.maxDays) {
    throw new AppError('VALIDATION_ERROR', 422, 'Invalid request', [
      {
        path: 'query.from',
        message: `The range must cover between 1 and ${ANALYTICS.maxDays} days`,
      },
    ]);
  }
  return { fromMs: start, toMs: end, from: new Date(start), to: new Date(end), days };
}

const rangeView = (range) => ({ from: isoDay(range.fromMs), to: isoDay(range.toMs - DAY_MS) });

const hashOf = (params) =>
  createHash('sha1').update(JSON.stringify(params)).digest('hex').slice(0, 16);

// Ids go to Mongo in slices, so one request never nears the 16 MB command limit however many
// orders a wide range holds.
const CHUNK = 2500;
const chunks = (list) => {
  const out = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
};

/** Adds `row` into `map[key]`, field by field (merging the partial results of the slices). */
function addInto(map, key, row, fields) {
  const into = map.get(key) ?? Object.fromEntries(fields.map((f) => [f, 0]));
  for (const f of fields) into[f] += row[f];
  map.set(key, into);
  return into;
}

/**
 * Admin analytics (D64, D67). Four read-only endpoints. Every result is cached for 5 minutes
 * by endpoint + parameters, TTL only (ARCHITECTURE 4): a refund or a new order appears after the
 * entry expires, and `generatedAt` says when it was computed. The cache is fail-open: with Redis
 * down the queries simply run on every request.
 *
 * How the numbers are read (D67): one aggregation over the indexed PAID orders of the range
 * returns their count, their total and their ids; the sub-orders and refunds of exactly those
 * orders are then summed by pipelines keyed on `orderId`. The first version joined every order
 * to its sub-orders with $lookup and took 1.3-2.5 s on 10,000 orders (the target is 500 ms);
 * a second one that grouped sub-orders per order was still too slow. Only totals (or totals per
 * vendor / product) are asked of Mongo now, never one row per order.
 */
export function createAnalyticsService({ cache }) {
  async function cached(endpoint, params, compute) {
    const key = CACHE.keys.analytics(endpoint, hashOf(params));
    const hit = await cache.getJson(key);
    if (hit) return hit;
    const result = { ...(await compute()), generatedAt: new Date().toISOString() };
    await cache.setJson(key, result, CACHE.ttlSeconds.analytics);
    return result;
  }

  // What counts (D64): orders that were PAID, with `placedAt` (the time payment was confirmed)
  // inside the range. Orders that expired or are still waiting for payment never enter a total.
  const paidMatch = (range) => ({
    $match: { paymentStatus: 'paid', placedAt: { $gte: range.from, $lt: range.to } },
  });

  async function paidOrders(range) {
    const [row] = await Order.aggregate([
      paidMatch(range),
      {
        $group: {
          _id: null,
          orderCount: { $sum: 1 },
          gmvPaise: { $sum: '$totalPaise' },
          ids: { $push: '$_id' },
        },
      },
    ]);
    return row ?? { orderCount: 0, gmvPaise: 0, ids: [] };
  }

  /** Runs `pipelineFor(slice)` over every slice of ids, concurrently, and returns all rows. */
  async function overSlices(model, ids, pipelineFor) {
    const parts = await Promise.all(
      chunks(ids).map((slice) => model.aggregate(pipelineFor(slice))),
    );
    return parts.flat();
  }

  return {
    /** GET /admin/analytics/overview: the headline totals for a range. */
    async overview(query = {}, { now = new Date() } = {}) {
      const range = resolveRange(query, now);
      const params = { from: range.fromMs, to: range.toMs };
      return cached('overview', params, async () => {
        const { orderCount, gmvPaise, ids } = await paidOrders(range);
        const [subRows, refundRows] = await Promise.all([
          overSlices(SubOrder, ids, (slice) => [
            { $match: { orderId: { $in: slice } } },
            {
              $group: {
                _id: null,
                subOrderCount: { $sum: 1 },
                commissionPaise: { $sum: '$commission.amountPaise' },
                refundedPaise: { $sum: '$refundedPaise' },
              },
            },
          ]),
          // Commission handed back by refunds that are reserved or processed (the rule D57 uses
          // for `subOrders.refundedPaise`); a failed refund reverses nothing.
          overSlices(Refund, ids, (slice) => [
            { $match: { orderId: { $in: slice }, status: { $in: ['initiated', 'processed'] } } },
            {
              $group: { _id: null, commissionReversedPaise: { $sum: '$commissionReversedPaise' } },
            },
          ]),
        ]);
        const sum = (rows, field) => rows.reduce((n, r) => n + r[field], 0);
        const refundedPaise = sum(subRows, 'refundedPaise');
        const commissionPaise = sum(subRows, 'commissionPaise');
        const commissionReversedPaise = sum(refundRows, 'commissionReversedPaise');
        return {
          range: rangeView(range),
          currency: 'INR',
          orderCount,
          subOrderCount: sum(subRows, 'subOrderCount'),
          gmvPaise,
          refundedPaise,
          netGmvPaise: gmvPaise - refundedPaise,
          commissionPaise,
          commissionReversedPaise,
          netCommissionPaise: commissionPaise - commissionReversedPaise,
          averageOrderValuePaise: orderCount > 0 ? mulDivRoundHalfUp(gmvPaise, 1, orderCount) : 0,
        };
      });
    },

    /**
     * GET /admin/analytics/sales-timeseries: one point per day (or month), empty ones included.
     * Orders and GMV only: commission per day would need the sub-orders of every order joined to
     * its paid date, which is what made the first design too slow (D67).
     */
    async salesTimeseries({ interval = 'day', ...query } = {}, { now = new Date() } = {}) {
      const range = resolveRange(query, now);
      const params = { from: range.fromMs, to: range.toMs, interval };
      return cached('sales-timeseries', params, async () => {
        const format = interval === 'month' ? '%Y-%m' : '%Y-%m-%d';
        const rows = await Order.aggregate([
          paidMatch(range),
          {
            $group: {
              _id: { $dateToString: { format, date: '$placedAt', timezone: 'UTC' } },
              orderCount: { $sum: 1 },
              gmvPaise: { $sum: '$totalPaise' },
            },
          },
        ]);
        const byBucket = new Map(rows.map((r) => [r._id, r]));
        const points = bucketsFor(range, interval).map((bucket) => ({
          bucket,
          orderCount: byBucket.get(bucket)?.orderCount ?? 0,
          gmvPaise: byBucket.get(bucket)?.gmvPaise ?? 0,
        }));
        return { range: rangeView(range), currency: 'INR', interval, points };
      });
    },

    /** GET /admin/analytics/top-vendors: ranked by what customers paid for their sub-orders. */
    async topVendors({ limit = ANALYTICS.topDefault, ...query } = {}, { now = new Date() } = {}) {
      const range = resolveRange(query, now);
      const params = { from: range.fromMs, to: range.toMs, limit };
      return cached('top-vendors', params, async () => {
        const { ids } = await paidOrders(range);
        const rows = await overSlices(SubOrder, ids, (slice) => [
          { $match: { orderId: { $in: slice } } },
          {
            $group: {
              _id: '$vendorId',
              subOrderCount: { $sum: 1 },
              gmvPaise: { $sum: '$customerTotalPaise' },
              commissionPaise: { $sum: '$commission.amountPaise' },
              refundedPaise: { $sum: '$refundedPaise' },
            },
          },
        ]);
        const fields = ['subOrderCount', 'gmvPaise', 'commissionPaise', 'refundedPaise'];
        const byVendor = new Map();
        for (const r of rows) addInto(byVendor, String(r._id), r, fields);
        const ranked = [...byVendor.entries()]
          .sort(([ka, a], [kb, b]) => b.gmvPaise - a.gmvPaise || ka.localeCompare(kb))
          .slice(0, limit);
        const shops = await Vendor.find(
          { _id: { $in: ranked.map(([id]) => id) } },
          'shopName shopSlug',
        );
        const shopById = new Map(shops.map((sh) => [sh.id, sh]));
        return {
          range: rangeView(range),
          currency: 'INR',
          items: ranked.map(([vendorId, t]) => ({
            vendorId,
            shopName: shopById.get(vendorId)?.shopName ?? null,
            shopSlug: shopById.get(vendorId)?.shopSlug ?? null,
            ...t,
          })),
        };
      });
    },

    /** GET /admin/analytics/top-products: ranked by revenue; cancelled sub-orders are left out. */
    async topProducts({ limit = ANALYTICS.topDefault, ...query } = {}, { now = new Date() } = {}) {
      const range = resolveRange(query, now);
      const params = { from: range.fromMs, to: range.toMs, limit };
      return cached('top-products', params, async () => {
        const { ids } = await paidOrders(range);
        const rows = await overSlices(SubOrder, ids, (slice) => [
          { $match: { orderId: { $in: slice }, fulfillmentStatus: { $ne: 'cancelled' } } },
          { $project: { vendorId: 1, items: 1 } },
          { $unwind: '$items' },
          {
            $group: {
              _id: '$items.productId',
              title: { $max: '$items.title' },
              vendorId: { $first: '$vendorId' },
              unitsSold: { $sum: '$items.quantity' },
              revenuePaise: { $sum: '$items.lineNetPaise' },
            },
          },
        ]);
        const fields = ['unitsSold', 'revenuePaise'];
        const byProduct = new Map();
        const meta = new Map(); // productId -> { title, vendorId }
        for (const r of rows) {
          addInto(byProduct, String(r._id), r, fields);
          if (!meta.has(String(r._id))) meta.set(String(r._id), r);
        }
        const ranked = [...byProduct.entries()]
          .sort(([ka, a], [kb, b]) => b.revenuePaise - a.revenuePaise || ka.localeCompare(kb))
          .slice(0, limit);
        const shops = await Vendor.find(
          { _id: { $in: ranked.map(([id]) => meta.get(id).vendorId) } },
          'shopName',
        );
        const shopById = new Map(shops.map((sh) => [sh.id, sh]));
        return {
          range: rangeView(range),
          currency: 'INR',
          items: ranked.map(([productId, t]) => {
            const m = meta.get(productId);
            return {
              productId,
              title: m.title,
              vendorId: String(m.vendorId),
              shopName: shopById.get(String(m.vendorId))?.shopName ?? null,
              ...t,
            };
          }),
        };
      });
    },
  };
}

/** Every day (or month) label inside the range, so a chart has no holes. */
export function bucketsFor(range, interval) {
  const labels = [];
  if (interval === 'month') {
    const start = new Date(range.fromMs);
    const last = new Date(range.toMs - 1);
    let y = start.getUTCFullYear();
    let m = start.getUTCMonth();
    while (y < last.getUTCFullYear() || (y === last.getUTCFullYear() && m <= last.getUTCMonth())) {
      labels.push(`${y}-${String(m + 1).padStart(2, '0')}`);
      m += 1;
      if (m === 12) {
        m = 0;
        y += 1;
      }
    }
    return labels;
  }
  for (let ms = range.fromMs; ms < range.toMs; ms += DAY_MS) labels.push(isoDay(ms));
  return labels;
}
