import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { RETURN_WINDOW_DAYS } from '../../config/constants.js';
import { AppError } from '../../lib/AppError.js';
import { pageMeta, skipFor } from '../../lib/pagination.js';
import { Settlement } from '../settlements/settlements.model.js';
import { Order, SubOrder } from './orders.model.js';
import { assertTransition } from './orders.transitions.js';

const inTransaction = (work) => mongoose.connection.transaction(work);
const DAY_MS = 86_400_000;
const notFound = () => new AppError('NOT_FOUND', 404, 'Sub-order not found');
// A sub-order was paid if it ever reached `processing`. Unpaid and expired ones stay hidden.
const PAID = { 'statusHistory.status': 'processing' };

/**
 * Fulfilment (ARCHITECTURE 3.3, API_CONTRACTS section 3): the vendor moves a sub-order along
 * processing -> shipped -> delivered; the customer or the vendor may cancel before it ships.
 * Every move is one conditional update on the current status (so a double click, or the vendor
 * and the customer acting together, changes the sub-order once), and the money side effects
 * (stock, refund, settlement) are written in the same transaction.
 */
export function createFulfillmentService({ lifecycle, refundsService, audit, logger }) {
  const presentForVendor = (sub, order, settlement) => ({
    id: sub.id,
    subOrderNumber: sub.subOrderNumber,
    orderNumber: order?.orderNumber ?? null,
    items: sub.items.map((i) => ({
      productId: String(i.productId),
      title: i.title,
      sku: i.sku,
      unitPricePaise: i.unitPricePaise,
      quantity: i.quantity,
      lineNetPaise: i.lineNetPaise,
    })),
    subtotalPaise: sub.subtotalPaise,
    discountPaise: sub.discountPaise,
    customerTotalPaise: sub.customerTotalPaise,
    commission: { rateBps: sub.commission.rateBps, amountPaise: sub.commission.amountPaise },
    vendorPayoutPaise: sub.vendorPayoutPaise,
    fulfillmentStatus: sub.fulfillmentStatus,
    refundStatus: sub.refundStatus,
    refundedPaise: sub.refundedPaise,
    tracking: sub.tracking ?? null,
    // The vendor sees where to send the goods, and nothing else about the customer (PROJECT_MASTER 3).
    shippingAddress: order?.shippingAddress ?? null,
    settlementStatus: settlement?.status ?? null,
    deliveredAt: sub.deliveredAt ?? null,
    returnWindowEndsAt: sub.returnWindowEndsAt ?? null,
    createdAt: sub.createdAt,
  });

  async function presentMany(subs) {
    const [orders, settlements] = await Promise.all([
      Order.find({ _id: { $in: subs.map((s) => s.orderId) } }, 'orderNumber shippingAddress'),
      Settlement.find({ subOrderId: { $in: subs.map((s) => s._id) } }, 'subOrderId status'),
    ]);
    const orderById = new Map(orders.map((o) => [o.id, o]));
    const settlementBySub = new Map(settlements.map((s) => [String(s.subOrderId), s]));
    return subs.map((s) =>
      presentForVendor(s, orderById.get(String(s.orderId)), settlementBySub.get(s.id)),
    );
  }

  /** order -> completed (all delivered or cancelled) or cancelled (all cancelled). */
  async function syncOrderStatus(orderId, { session }) {
    const subs = await SubOrder.find({ orderId }, 'fulfillmentStatus').session(session);
    const states = subs.map((s) => s.fulfillmentStatus);
    const target = states.every((s) => s === 'cancelled')
      ? 'cancelled'
      : states.every((s) => s === 'delivered' || s === 'cancelled')
        ? 'completed'
        : null;
    if (target) {
      await Order.updateOne(
        { _id: orderId, status: 'placed' },
        { $set: { status: target } },
        { session },
      );
    }
  }

  /**
   * processing -> cancelled, the stock goes back (once: `stockRestored`), and everything the
   * customer has not been refunded yet is refunded, all in one transaction. `scope` pins WHO may
   * do it (customer id or vendor id), so someone else's sub-order is a 404 (D15).
   */
  async function cancelAndRefund({
    scope,
    actor,
    reason,
    note,
    requestedBy,
    idempotencyKey,
    now = new Date(),
  }) {
    const key = idempotencyKey ?? `cancel:${scope._id}`;
    const outcome = await inTransaction(async (session) => {
      const sub = await SubOrder.findOneAndUpdate(
        { ...scope, fulfillmentStatus: 'processing' },
        {
          $set: { fulfillmentStatus: 'cancelled' },
          $push: {
            statusHistory: { status: 'cancelled', at: now, byUserId: requestedBy, note: reason },
          },
        },
        { session, returnDocument: 'after' },
      );
      if (!sub) return null;
      const flipped = await lifecycle.restoreStock([sub], { session });
      const remaining = sub.customerTotalPaise - sub.refundedPaise;
      let refund = null;
      if (remaining > 0) {
        refund = await refundsService.reserve({
          session,
          subOrderId: sub._id,
          amountPaise: remaining,
          reason,
          note,
          requestedBy,
          idempotencyKey: key,
        });
      } else {
        // Already refunded in full while unshipped: the settlement has nothing left to pay.
        await Settlement.updateOne(
          { subOrderId: sub._id, status: { $in: ['not_eligible', 'pending_release'] } },
          { $set: { status: 'reversed' } },
          { session },
        );
      }
      await syncOrderStatus(sub.orderId, { session });
      if (reason === 'admin') {
        await audit.record(
          actor,
          {
            action: 'refund.created',
            entityType: 'subOrder',
            entityId: sub._id,
            meta: { refundId: refund?.id, amountPaise: remaining, cancelled: true },
          },
          { session },
        );
      }
      return { sub, refund, flipped };
    });

    if (!outcome) {
      const current = await SubOrder.findOne(scope, 'fulfillmentStatus');
      if (!current) throw notFound();
      assertTransition(
        current.fulfillmentStatus,
        'cancelled',
        actor.role === 'customer' ? 'customer' : 'vendor',
      );
      throw new AppError('CONFLICT', 409, 'The sub-order changed, try again'); // lost a race
    }
    await lifecycle.invalidateProducts(outcome.flipped.map((p) => p.slug));
    logger.info({ subOrderId: outcome.sub.id, reason }, 'suborder.cancelled');
    // After the commit: ask the provider. If it is down the refund stays `initiated` and is retried.
    if (outcome.refund) await refundsService.finish(outcome.refund._id);
    return { sub: outcome.sub, refund: outcome.refund };
  }

  return {
    cancelAndRefund,

    async listForVendor(vendor, { fulfillmentStatus, page, limit }) {
      const filter = {
        vendorId: vendor.id,
        ...PAID,
        ...(fulfillmentStatus && { fulfillmentStatus }),
      };
      const [subs, total] = await Promise.all([
        SubOrder.find(filter).sort({ createdAt: -1 }).skip(skipFor({ page, limit })).limit(limit),
        SubOrder.countDocuments(filter),
      ]);
      return { items: await presentMany(subs), meta: pageMeta({ page, limit }, total) };
    },

    async getForVendor(vendor, subOrderId) {
      const sub = await SubOrder.findOne({ _id: subOrderId, vendorId: vendor.id, ...PAID });
      if (!sub) throw notFound();
      return (await presentMany([sub]))[0];
    },

    /** PATCH /vendor/sub-orders/:id/status. Only an approved shop fulfils orders. */
    async updateStatus(vendor, actor, subOrderId, { status, tracking }) {
      if (vendor.status !== 'approved') {
        throw new AppError(
          'VENDOR_NOT_APPROVED',
          403,
          'Your shop must be approved to fulfil orders',
        );
      }
      const scope = { _id: subOrderId, vendorId: vendor.id, ...PAID };
      const sub = await SubOrder.findOne(scope);
      if (!sub) throw notFound();

      if (status === 'cancelled') {
        await cancelAndRefund({
          scope: { _id: subOrderId, vendorId: vendor.id },
          actor,
          reason: 'vendor_cancel',
          requestedBy: actor.id,
        });
        return (await presentMany([await SubOrder.findById(subOrderId)]))[0];
      }
      assertTransition(sub.fulfillmentStatus, status, 'vendor');

      const now = new Date();
      const updated = await inTransaction(async (session) => {
        const changes =
          status === 'shipped'
            ? { fulfillmentStatus: 'shipped', tracking }
            : {
                fulfillmentStatus: 'delivered',
                deliveredAt: now,
                returnWindowEndsAt: new Date(now.getTime() + RETURN_WINDOW_DAYS * DAY_MS),
              };
        const next = await SubOrder.findOneAndUpdate(
          { ...scope, fulfillmentStatus: sub.fulfillmentStatus },
          { $set: changes, $push: { statusHistory: { status, at: now, byUserId: actor.id } } },
          { session, returnDocument: 'after' },
        );
        if (!next) return null; // someone else moved it first
        if (status === 'delivered') {
          // The money becomes payable only after delivery (+ the return window). A settlement
          // that was already reversed (fully refunded while shipped) stays reversed.
          await Settlement.updateOne(
            { subOrderId: next._id, status: 'not_eligible' },
            { $set: { status: 'pending_release', eligibleAt: next.returnWindowEndsAt } },
            { session },
          );
          await syncOrderStatus(next.orderId, { session });
        }
        return next;
      });
      if (!updated) {
        const latest = await SubOrder.findOne(scope);
        assertTransition(latest.fulfillmentStatus, status, 'vendor');
        throw new AppError('CONFLICT', 409, 'The sub-order changed, try again'); // lost a race
      }
      logger.info({ subOrderId, status }, 'suborder.status_changed');
      return (await presentMany([updated]))[0];
    },

    /** POST /orders/:orderId/sub-orders/:subOrderId/cancel (customer, before it ships). */
    async cancelForCustomer(customer, { orderId, subOrderId }) {
      const { sub, refund } = await cancelAndRefund({
        scope: { _id: subOrderId, orderId, customerId: customer.id },
        actor: { id: customer.id, role: 'customer' },
        reason: 'customer_cancel',
        requestedBy: customer.id,
        idempotencyKey: `cancel:${subOrderId}`,
      });
      return { subOrderId: sub.id, refundId: refund?.id ?? null };
    },

    /** Admin full refund of an unshipped sub-order: same path, reason `admin`. */
    async cancelForAdmin(args) {
      const { sub, refund } = await cancelAndRefund({
        scope: { _id: args.subOrderId },
        actor: args.actor,
        reason: args.reason,
        note: args.note,
        requestedBy: args.requestedBy,
        idempotencyKey: args.idempotencyKey,
      });
      return { sub, refund };
    },

    newKey: () => randomUUID(),
  };
}
