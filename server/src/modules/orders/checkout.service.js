import mongoose from 'mongoose';
import {
  MIN_TOTAL_PAISE,
  MIN_TRANSFER_PAISE,
  RESERVATION_MINUTES,
} from '../../config/constants.js';
import { AppError } from '../../lib/AppError.js';
import { Cart } from '../cart/cart.model.js';
import { Category } from '../catalog/categories.model.js';
import { Product } from '../catalog/products.model.js';
import { Coupon } from '../coupons/coupons.model.js';
import { evaluateCoupon } from '../coupons/coupons.rules.js';
import { CouponRedemption } from '../coupons/redemptions.model.js';
import { Payment } from '../payments/payments.model.js';
import { Settlement } from '../settlements/settlements.model.js';
import { Vendor } from '../shops/shops.model.js';
import { User } from '../users/users.model.js';
import { initialSettlementMoney } from '../../lib/commission.js';
import { Counter, Order, SubOrder } from './orders.model.js';
import { buildOrderDraft } from './orders.money.js';

const inTransaction = (work) => mongoose.connection.transaction(work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const validation = (reason, message, extra = {}) =>
  new AppError('VALIDATION_ERROR', 422, message, { reason, ...extra });
const couponInvalid = (reason) =>
  new AppError('COUPON_INVALID', 422, 'This coupon cannot be applied', { reason });

/**
 * POST /checkout (ARCHITECTURE 3.1, DECISIONS D7, D21, D45-D50).
 *
 * One Mongo transaction re-reads prices, stock and the coupon, decides every rejection BEFORE the
 * first stock write, then writes order, sub-orders, settlements, payment, coupon reservation and
 * the stock decrement together and clears the cart. The provider order is created after the
 * commit; if that fails, the order is expired again (stock and coupon restored) and the caller
 * gets a 502.
 */
export function createCheckoutService({
  paymentProvider,
  platformCommissionBps,
  lifecycle,
  searchOutbox,
  logger,
  replayWaitMs = 4000,
}) {
  /** MP-YYYYMMDD-NNNNNN. Taken outside the transaction so the counter never becomes a hot spot. */
  async function nextOrderNumber(date) {
    const ymd = date.toISOString().slice(0, 10).replaceAll('-', '');
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const counter = await Counter.findOneAndUpdate(
          { _id: `orderNumber:${ymd}` },
          { $inc: { seq: 1 } },
          { upsert: true, returnDocument: 'after' },
        );
        return `MP-${ymd}-${String(counter.seq).padStart(6, '0')}`;
      } catch (err) {
        if (err?.code !== 11000) throw err; // two first-of-the-day upserts collided: try again
      }
    }
    throw new AppError('CONFLICT', 409, 'Could not allocate an order number, please retry');
  }

  const presentCheckout = (order, payment) => ({
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      subtotalPaise: order.subtotalPaise,
      discountPaise: order.discountPaise,
      shippingPaise: order.shippingPaise,
      totalPaise: order.totalPaise,
      reservationExpiresAt: order.reservationExpiresAt,
    },
    payment: {
      provider: payment.provider,
      providerOrderId: payment.providerOrderId,
      keyId: paymentProvider.publicKeyId,
      amountPaise: payment.amountPaise,
      currency: payment.currency,
    },
  });

  /**
   * The same Idempotency-Key was used before. Returns the original order. The request that won the
   * race may still be creating the provider order, so wait briefly for it.
   */
  async function replay(customerId, idempotencyKey) {
    const deadline = Date.now() + replayWaitMs;
    for (;;) {
      const order = await Order.findOne({ customerId, idempotencyKey });
      if (!order) return null;
      if (order.status === 'expired' || order.status === 'cancelled') {
        throw new AppError(
          'CONFLICT',
          409,
          'That checkout attempt expired or failed; start again with a new Idempotency-Key',
        );
      }
      const payment = await Payment.findOne({ orderId: order._id });
      if (payment?.providerOrderId || order.status !== 'pending_payment') {
        return presentCheckout(order, payment);
      }
      if (Date.now() >= deadline) {
        throw new AppError('CONFLICT', 409, 'This checkout is still being processed, please retry');
      }
      await sleep(100);
    }
  }

  /** The transaction body. Everything that can reject does so before the first write. */
  async function reserveAndCreate(
    session,
    { customerId, idempotencyKey, addressId, couponCode, orderNumber, now },
  ) {
    const user = await User.findById(customerId).session(session);
    const address = user?.addresses.id(addressId);
    if (!address) {
      throw new AppError('VALIDATION_ERROR', 422, 'Invalid request', [
        { path: 'body.addressId', message: 'Address not found' },
      ]);
    }

    const cart = await Cart.findOne({ customerId }).session(session);
    if (!cart || cart.items.length === 0) throw validation('empty_cart', 'Your cart is empty');
    // Touching the cart first serialises two checkouts of the same customer (and two retries with
    // one Idempotency-Key): the second one conflicts here and then finds the cart empty.
    await Cart.updateOne(
      { customerId },
      { $set: { items: [] }, $unset: { couponCode: 1 } },
      { session },
    );

    // ---- read everything ----
    const productIds = cart.items.map((i) => i.productId);
    const products = await Product.find({ _id: { $in: productIds } }).session(session);
    const productById = new Map(products.map((p) => [p.id, p]));
    const vendors = await Vendor.find({
      _id: { $in: [...new Set(products.map((p) => String(p.vendorId)))] },
    }).session(session);
    const vendorById = new Map(vendors.map((v) => [v.id, v]));
    const categories = await Category.find({
      _id: { $in: [...new Set(products.map((p) => String(p.categoryId)))] },
    }).session(session);

    const unavailable = [];
    const short = [];
    const lines = [];
    for (const item of cart.items) {
      const product = productById.get(String(item.productId));
      const shop = product && vendorById.get(String(product.vendorId));
      if (!product || product.status !== 'active' || shop?.status !== 'approved') {
        unavailable.push({ productId: String(item.productId) });
        continue;
      }
      if (product.stockQty < item.quantity) {
        short.push({ productId: product.id, available: product.stockQty });
      }
      lines.push({
        productId: product.id,
        vendorId: String(product.vendorId),
        categoryId: String(product.categoryId),
        title: product.title,
        sku: product.sku,
        imageKey: product.images[0]?.key,
        unitPricePaise: product.pricePaise,
        quantity: item.quantity,
      });
    }
    if (unavailable.length) {
      throw new AppError('CONFLICT', 409, 'Some products are no longer available', {
        reason: 'unavailable',
        items: unavailable,
      });
    }
    if (short.length) {
      throw new AppError('OUT_OF_STOCK', 409, 'Not enough stock for some products', short);
    }

    // ---- coupon (re-evaluated now, D43; omitted code = the cart's saved coupon, null = none) ----
    const code = couponCode === undefined ? cart.couponCode : couponCode;
    let coupon = null;
    let evaluation = null;
    if (code) {
      coupon = await Coupon.findOne({ code }).session(session);
      if (!coupon) throw couponInvalid('not_found');
      const usesByCustomer = await CouponRedemption.countDocuments({
        couponId: coupon._id,
        customerId,
        status: { $in: ['reserved', 'redeemed'] },
      }).session(session);
      evaluation = evaluateCoupon(coupon, {
        lines: lines.map((l) => ({
          vendorId: l.vendorId,
          lineSubtotalPaise: l.unitPricePaise * l.quantity,
        })),
        now,
        usesByCustomer,
      });
      if (!evaluation.ok) throw couponInvalid(evaluation.reason);
    }

    // ---- money (D6) ----
    const draft = buildOrderDraft({
      lines,
      evaluation: evaluation?.ok ? evaluation : null,
      fundedBy: coupon?.fundedBy ?? 'vendor',
      platformBps: platformCommissionBps,
      vendorBpsById: new Map(vendors.map((v) => [v.id, v.commissionRateBps ?? null])),
      categoryBpsById: new Map(categories.map((c) => [c.id, c.defaultCommissionBps ?? null])),
    });

    // ---- provider-neutral rejections (D47, D49, D50), in the documented order ----
    if (draft.totalPaise < MIN_TOTAL_PAISE) {
      throw validation(
        draft.totalPaise === 0 ? 'zero_total' : 'below_minimum_total',
        'The order total is below the minimum of INR 1.00',
      );
    }
    const accounts = new Map();
    const withoutAccount = [];
    for (const so of draft.subOrders) {
      const account = await paymentProvider.resolvePayoutAccount(vendorById.get(so.vendorId));
      if (account?.active && account.linkedAccountId)
        accounts.set(so.vendorId, account.linkedAccountId);
      else withoutAccount.push(...so.items.map((i) => i.productId));
    }
    if (withoutAccount.length) {
      throw new AppError('CONFLICT', 409, 'A seller in your cart cannot receive payments yet', {
        reason: 'vendor_payout_unavailable',
        productIds: withoutAccount,
      });
    }
    const tiny = draft.subOrders.filter((so) => so.vendorPayoutPaise < MIN_TRANSFER_PAISE);
    if (tiny.length) {
      throw validation(
        'payout_below_minimum',
        'An order slice is too small to pay out to its seller',
        {
          productIds: tiny.flatMap((so) => so.items.map((i) => i.productId)),
        },
      );
    }
    if (draft.subOrders.reduce((sum, so) => sum + so.vendorPayoutPaise, 0) > draft.totalPaise) {
      throw couponInvalid('exceeds_platform_margin');
    }

    // ---- writes ----
    const flipped = [];
    for (const line of [...lines].sort((a, b) => (a.productId < b.productId ? -1 : 1))) {
      const after = await Product.findOneAndUpdate(
        { _id: line.productId, status: 'active', stockQty: { $gte: line.quantity } },
        { $inc: { stockQty: -line.quantity } },
        { session, returnDocument: 'after', projection: { slug: 1, stockQty: 1 } },
      );
      if (!after) {
        // Lost a race for the last units. Report current availability for every line.
        const now2 = await Product.find({ _id: { $in: productIds } }, { stockQty: 1 }).session(
          session,
        );
        const available = new Map(now2.map((p) => [p.id, p.stockQty]));
        throw new AppError(
          'OUT_OF_STOCK',
          409,
          'Not enough stock for some products',
          lines
            .filter((l) => (available.get(l.productId) ?? 0) < l.quantity)
            .map((l) => ({ productId: l.productId, available: available.get(l.productId) ?? 0 })),
        );
      }
      if (after.stockQty === 0) flipped.push(after);
    }
    if (flipped.length)
      await searchOutbox.enqueue(
        flipped.map((p) => p._id),
        { session },
      );

    const orderId = new mongoose.Types.ObjectId();
    const paymentId = new mongoose.Types.ObjectId();

    if (coupon) {
      const reserved = await Coupon.findOneAndUpdate(
        {
          _id: coupon._id,
          status: 'active',
          $or: [
            { usageLimitTotal: { $exists: false } },
            { usageLimitTotal: null },
            { $expr: { $lt: ['$usedCount', '$usageLimitTotal'] } },
          ],
        },
        { $inc: { usedCount: 1 } },
        { session },
      );
      if (!reserved) throw couponInvalid('total_limit_reached');
      await CouponRedemption.create(
        [
          {
            couponId: coupon._id,
            customerId,
            orderId,
            discountPaise: draft.discountPaise,
            status: 'reserved',
          },
        ],
        { session },
      );
    }

    const [order] = await Order.create(
      [
        {
          _id: orderId,
          orderNumber,
          customerId,
          status: 'pending_payment',
          paymentStatus: 'unpaid',
          shippingAddress: {
            label: address.label,
            name: address.name,
            phone: address.phone,
            line1: address.line1,
            line2: address.line2,
            city: address.city,
            state: address.state,
            postalCode: address.postalCode,
            country: address.country,
          },
          subtotalPaise: draft.subtotalPaise,
          discountPaise: draft.discountPaise,
          shippingPaise: draft.shippingPaise,
          totalPaise: draft.totalPaise,
          coupon: coupon
            ? {
                couponId: coupon._id,
                code: coupon.code,
                fundedBy: coupon.fundedBy,
                discountPaise: draft.discountPaise,
              }
            : null,
          reservationExpiresAt: new Date(now.getTime() + RESERVATION_MINUTES * 60_000),
          idempotencyKey,
          paymentId,
        },
      ],
      { session },
    );

    const subDocs = draft.subOrders.map((so, i) => ({
      _id: new mongoose.Types.ObjectId(),
      subOrderNumber: `${orderNumber}-V${i + 1}`,
      orderId,
      customerId,
      vendorId: so.vendorId,
      items: so.items,
      subtotalPaise: so.subtotalPaise,
      discountPaise: so.discountPaise,
      shippingPaise: so.shippingPaise,
      customerTotalPaise: so.customerTotalPaise,
      commission: so.commission,
      vendorPayoutPaise: so.vendorPayoutPaise,
      fulfillmentStatus: 'pending_payment',
      statusHistory: [{ status: 'pending_payment', at: now }],
    }));
    const subOrders = await SubOrder.create(subDocs, { session, ordered: true });
    await Settlement.create(
      subOrders.map((sub) => ({
        subOrderId: sub._id,
        orderId,
        vendorId: sub.vendorId,
        status: 'not_eligible',
        ...initialSettlementMoney({
          basePaise: sub.commission.basePaise,
          commissionPaise: sub.commission.amountPaise,
        }),
      })),
      { session, ordered: true },
    );
    const [payment] = await Payment.create(
      [
        {
          _id: paymentId,
          orderId,
          provider: paymentProvider.name,
          amountPaise: draft.totalPaise,
          currency: 'INR',
          status: 'created',
        },
      ],
      { session },
    );

    // What the customer had in the cart: put back if the provider order cannot be created.
    const cartSnapshot = {
      items: cart.items.map((i) => ({
        productId: i.productId,
        quantity: i.quantity,
        addedAt: i.addedAt,
      })),
      couponCode: cart.couponCode,
    };
    return { order, payment, subOrders, accounts, flipped, cartSnapshot };
  }

  /** The provider order is created after the commit; on failure the order is expired again. */
  async function createProviderOrder({ order, payment, subOrders, accounts, cartSnapshot }) {
    const transfers = subOrders.map((sub) => ({
      linkedAccountId: accounts.get(String(sub.vendorId)),
      amountPaise: sub.vendorPayoutPaise,
      notes: { orderNumber: order.orderNumber, subOrderNumber: sub.subOrderNumber },
    }));
    try {
      const created = await paymentProvider.createOrder({
        amountPaise: order.totalPaise,
        receipt: order.orderNumber,
        transfers,
      });
      if (!created?.providerOrderId || created.transfers?.length !== transfers.length) {
        throw new AppError(
          'PAYMENT_PROVIDER_ERROR',
          502,
          'The payment provider answered unexpectedly',
        );
      }
      await Payment.updateOne(
        { _id: payment._id, providerOrderId: { $exists: false } },
        { $set: { providerOrderId: created.providerOrderId } },
      );
      await Promise.all(
        subOrders.map((sub, i) =>
          Settlement.updateOne(
            { subOrderId: sub._id },
            { $set: { providerTransferId: created.transfers[i].providerTransferId } },
          ),
        ),
      );
      payment.providerOrderId = created.providerOrderId;
      return payment;
    } catch (err) {
      logger.warn({ err: err.message, orderId: order.id }, 'Provider order creation failed');
      await lifecycle
        .expireOrder(order._id, { reason: 'provider_error' })
        .catch((compensationErr) =>
          logger.error({ err: compensationErr, orderId: order.id }, 'Checkout compensation failed'),
        );
      // The customer did nothing wrong: give the cart back (only if they have not refilled it).
      await Cart.updateOne(
        { customerId: order.customerId, 'items.0': { $exists: false } },
        {
          $set: {
            items: cartSnapshot.items,
            ...(cartSnapshot.couponCode && { couponCode: cartSnapshot.couponCode }),
          },
        },
      ).catch((cartErr) =>
        logger.error({ err: cartErr, orderId: order.id }, 'Cart restore failed'),
      );
      throw err instanceof AppError && err.code === 'PAYMENT_PROVIDER_ERROR'
        ? err
        : new AppError('PAYMENT_PROVIDER_ERROR', 502, 'The payment provider is unavailable');
    }
  }

  return {
    /**
     * Returns { replayed, data } where data is the POST /checkout response body. `replayed` is
     * true when the Idempotency-Key had already created an order.
     */
    async checkout(customerId, { idempotencyKey, addressId, couponCode }) {
      const earlier = await replay(customerId, idempotencyKey);
      if (earlier) return { replayed: true, data: earlier };

      const now = new Date();
      const orderNumber = await nextOrderNumber(now);
      let created;
      try {
        created = await inTransaction((session) =>
          reserveAndCreate(session, {
            customerId,
            idempotencyKey,
            addressId,
            couponCode,
            orderNumber,
            now,
          }),
        );
      } catch (err) {
        // A concurrent request with the same key may have won; then this one is just a replay.
        const raced = await replay(customerId, idempotencyKey).catch(() => null);
        if (raced) return { replayed: true, data: raced };
        throw err;
      }

      if (created.flipped.length) {
        await lifecycle.invalidateProducts(created.flipped.map((p) => p.slug));
      }
      const payment = await createProviderOrder(created);
      logger.info(
        { orderId: created.order.id, orderNumber, totalPaise: created.order.totalPaise },
        'order.placed_pending_payment',
      );
      return { replayed: false, data: presentCheckout(created.order, payment) };
    },
  };
}
