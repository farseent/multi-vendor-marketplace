import mongoose from 'mongoose';
import { AppError } from '../../lib/AppError.js';
import { Coupon } from '../coupons/coupons.model.js';
import { CouponRedemption } from '../coupons/redemptions.model.js';
import { Product } from '../catalog/products.model.js';
import { Order, SubOrder } from '../orders/orders.model.js';
import { Refund } from '../refunds/refunds.model.js';
import { Payment } from './payments.model.js';

const inTransaction = (work) => mongoose.connection.transaction(work);

const verificationFailed = () =>
  new AppError('PAYMENT_VERIFICATION_FAILED', 400, 'The payment could not be verified');

/** Thrown inside the late-capture transaction to roll it back when the stock is gone. */
class StockUnavailable extends Error {}

/**
 * Payment confirmation (ARCHITECTURE 3.1 steps 5-7, DECISIONS D46, D48).
 *
 * Three callers confirm a payment: the browser (`verify`), the webhook and the reconcile job.
 * They all end in `markOrderPaid`, which is one conditional update, so whichever arrives first
 * wins and the others see the finished state and change nothing.
 */
export function createPaymentsService({
  paymentProvider,
  lifecycle,
  searchOutbox,
  logger,
  nodeEnv,
}) {
  const orderState = (order) => ({
    orderId: order.id,
    status: order.status,
    paymentStatus: order.paymentStatus,
    refundStatus: order.refundStatus,
  });

  /** The provider's payment must be the one for THIS order, in the amount we asked for. */
  function assertMatches(payment, providerPayment) {
    if (
      providerPayment.orderId !== payment.providerOrderId ||
      providerPayment.amountPaise !== payment.amountPaise ||
      providerPayment.currency !== payment.currency
    ) {
      logger.warn(
        { paymentId: payment.id, expected: payment.amountPaise, got: providerPayment.amountPaise },
        'Provider payment does not match the order',
      );
      throw verificationFailed();
    }
  }

  const capturedFields = (providerPayment, via, now) => ({
    status: 'captured',
    providerPaymentId: providerPayment.id,
    method: providerPayment.method,
    capturedAt: now,
    confirmedVia: via,
  });

  /** Normal path: pending_payment -> placed. Returns true if THIS call made the change. */
  async function placeOrder(session, payment, providerPayment, via, now) {
    const order = await Order.findOneAndUpdate(
      { _id: payment.orderId, status: 'pending_payment', paymentStatus: 'unpaid' },
      { $set: { status: 'placed', paymentStatus: 'paid', placedAt: now, paymentId: payment._id } },
      { session, returnDocument: 'after' },
    );
    if (!order) return false;
    await SubOrder.updateMany(
      { orderId: order._id, fulfillmentStatus: 'pending_payment' },
      {
        $set: { fulfillmentStatus: 'processing' },
        $push: { statusHistory: { status: 'processing', at: now, note: 'payment_captured' } },
      },
      { session },
    );
    await CouponRedemption.updateOne(
      { orderId: order._id, status: 'reserved' },
      { $set: { status: 'redeemed' } },
      { session },
    );
    await Payment.updateOne(
      { _id: payment._id },
      { $set: capturedFields(providerPayment, via, now) },
      { session },
    );
    return true;
  }

  /**
   * Late capture (ARCHITECTURE 3.1 step 7): the order already expired and its stock was released.
   * Try to take the stock again; the whole transaction rolls back if any line is gone.
   */
  async function reReserve(payment, providerPayment, via, now) {
    return inTransaction(async (session) => {
      const order = await Order.findOneAndUpdate(
        { _id: payment.orderId, status: 'expired', paymentStatus: 'unpaid' },
        {
          $set: { status: 'placed', paymentStatus: 'paid', placedAt: now, paymentId: payment._id },
        },
        { session, returnDocument: 'after' },
      );
      if (!order) return { claimed: false, flipped: [] };

      const subOrders = await SubOrder.find({ orderId: order._id }).session(session);
      const flipped = [];
      for (const sub of subOrders) {
        for (const item of sub.items) {
          const after = await Product.findOneAndUpdate(
            { _id: item.productId, status: 'active', stockQty: { $gte: item.quantity } },
            { $inc: { stockQty: -item.quantity } },
            { session, returnDocument: 'after', projection: { slug: 1, stockQty: 1 } },
          );
          if (!after) throw new StockUnavailable();
          if (after.stockQty === 0) flipped.push(after);
        }
      }
      await SubOrder.updateMany(
        { orderId: order._id },
        {
          $set: { fulfillmentStatus: 'processing', stockRestored: false },
          $push: {
            statusHistory: { status: 'processing', at: now, note: 'late_capture_re_reserved' },
          },
        },
        { session },
      );
      // The customer already paid the discounted price, so the coupon is honoured even if its
      // limit was reached in the meantime.
      const redemption = await CouponRedemption.findOneAndUpdate(
        { orderId: order._id, status: 'released' },
        { $set: { status: 'redeemed' } },
        { session },
      );
      if (redemption)
        await Coupon.updateOne(
          { _id: redemption.couponId },
          { $inc: { usedCount: 1 } },
          { session },
        );
      await Payment.updateOne(
        { _id: payment._id },
        { $set: capturedFields(providerPayment, via, now) },
        { session },
      );
      if (flipped.length)
        await searchOutbox.enqueue(
          flipped.map((p) => p._id),
          { session },
        );
      return { claimed: true, flipped };
    });
  }

  /** No stock left: record the capture and refund the customer in full (idempotent). */
  async function refundLateCapture(payment, providerPayment, via, now) {
    await Payment.updateOne(
      { _id: payment._id },
      { $set: capturedFields(providerPayment, via, now) },
    );
    const idempotencyKey = `late_capture:${payment.id}`;
    try {
      await Refund.create({
        paymentId: payment._id,
        orderId: payment.orderId,
        amountPaise: payment.amountPaise,
        reason: 'failed_late_capture',
        note: 'Paid after the reservation expired and the stock was no longer available',
        status: 'initiated',
        idempotencyKey,
      });
    } catch (err) {
      if (err?.code !== 11000) throw err; // another caller already owns this refund
    }
    await finishRefund(idempotencyKey);
  }

  /** Calls the provider for an `initiated` late-capture refund. Safe to repeat (same receipt). */
  async function finishRefund(idempotencyKey) {
    // Atomic claim: only one caller at a time may ask the provider (a crashed caller's claim
    // expires after 60 s). Everyone else leaves the refund to the claimant.
    const refund = await Refund.findOneAndUpdate(
      {
        idempotencyKey,
        status: 'initiated',
        $or: [
          { providerCallAt: { $exists: false } },
          { providerCallAt: { $lt: new Date(Date.now() - 60_000) } },
        ],
      },
      { $set: { providerCallAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!refund) return (await Refund.findOne({ idempotencyKey }))?.status ?? null;
    const payment = await Payment.findById(refund.paymentId);
    try {
      const result = await paymentProvider.refundPayment({
        providerPaymentId: payment.providerPaymentId,
        amountPaise: refund.amountPaise,
        reverseAll: true, // full refund: take the held vendor transfers back as well (D45)
        receipt: idempotencyKey,
      });
      await Refund.updateOne(
        { _id: refund._id, status: 'initiated' },
        {
          $set: {
            providerRefundId: result.providerRefundId,
            status: result.status === 'processed' ? 'processed' : 'initiated',
          },
        },
      );
      await Order.updateOne(
        { _id: refund.orderId, status: 'expired' },
        { $set: { paymentStatus: 'paid', refundStatus: 'full' } },
      );
      logger.info(
        { orderId: String(refund.orderId), refundId: refund.id },
        'order.late_capture_refunded',
      );
      return 'refunded';
    } catch (err) {
      // Left `initiated` with the claim released: the reconcile job retries it.
      await Refund.updateOne({ _id: refund._id }, { $unset: { providerCallAt: 1 } });
      logger.error(
        { err: err.message, refundId: refund.id },
        'Late-capture refund failed, will retry',
      );
      return 'refund_pending';
    }
  }

  return {
    orderState,
    finishRefund,

    /**
     * Marks the order paid. `providerPayment` comes from a provider FETCH (never from a request
     * body). Throws PAYMENT_VERIFICATION_FAILED if it does not match the order.
     * Returns 'paid' | 'already_paid' | 'paid_late' | 'refunded' | 'refund_pending' | 'not_captured'.
     */
    async markOrderPaid({ payment, providerPayment, via, now = new Date() }) {
      if (providerPayment.status !== 'captured') return 'not_captured';
      assertMatches(payment, providerPayment);

      const placed = await inTransaction((session) =>
        placeOrder(session, payment, providerPayment, via, now),
      );
      if (placed) {
        logger.info({ orderId: String(payment.orderId), via }, 'order.paid');
        return 'paid';
      }
      const order = await Order.findById(payment.orderId);
      if (!order) return 'not_captured';
      if (order.paymentStatus === 'paid') return 'already_paid';
      if (order.status !== 'expired') return 'not_captured';

      try {
        const result = await reReserve(payment, providerPayment, via, now);
        if (!result.claimed) return 'already_paid'; // someone else got there first
        await lifecycle.invalidateProducts(result.flipped.map((p) => p.slug));
        logger.info({ orderId: order.id, via }, 'order.paid_late');
        return 'paid_late';
      } catch (err) {
        if (!(err instanceof StockUnavailable)) throw err;
      }
      await refundLateCapture(payment, providerPayment, via, now);
      return (await Refund.findOne({ idempotencyKey: `late_capture:${payment.id}` }))?.status ===
        'processed'
        ? 'refunded'
        : 'refund_pending';
    },

    /** POST /payments/verify: the browser's report after Checkout, checked against the provider. */
    async verify(customerId, { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
      const order = await Order.findOne({ _id: orderId, customerId });
      if (!order) throw new AppError('NOT_FOUND', 404, 'Order not found');
      const payment = await Payment.findOne({ orderId: order._id });
      if (!payment?.providerOrderId) {
        throw new AppError('CONFLICT', 409, 'This order has no payment to verify yet');
      }
      // D48: the signature is checked against OUR stored provider order id, never the client's.
      if (razorpayOrderId !== payment.providerOrderId) throw verificationFailed();
      const signatureOk = paymentProvider.verifyCheckoutSignature({
        providerOrderId: payment.providerOrderId,
        providerPaymentId: razorpayPaymentId,
        signature: razorpaySignature,
      });
      if (!signatureOk) throw verificationFailed();

      if (order.paymentStatus === 'paid') return orderState(order);
      const providerPayment = await paymentProvider.fetchPayment(razorpayPaymentId);
      if (providerPayment.orderId !== payment.providerOrderId) throw verificationFailed();
      if (providerPayment.status === 'failed' || providerPayment.status === 'created') {
        throw verificationFailed();
      }
      // `authorized` (not yet captured) is not an error: the webhook or reconcile finishes it (D48).
      if (providerPayment.status === 'captured') {
        await this.markOrderPaid({ payment, providerPayment, via: 'client_verify' });
      }
      return orderState(await Order.findById(order._id));
    },

    /**
     * Development only (MockLedger outside production): pretends the customer paid in the widget
     * and returns what Checkout would hand to the browser, so the UI can be demoed without
     * Razorpay. Any other provider, or production, answers 404.
     */
    async mockComplete(customerId, orderId) {
      if (paymentProvider.name !== 'mock' || nodeEnv === 'production') {
        throw new AppError('NOT_FOUND', 404, 'Route not found');
      }
      const order = await Order.findOne({ _id: orderId, customerId });
      const payment = order && (await Payment.findOne({ orderId: order._id }));
      if (!payment?.providerOrderId) throw new AppError('NOT_FOUND', 404, 'Order not found');
      const { providerPaymentId, signature } = paymentProvider.simulatePayment(
        payment.providerOrderId,
      );
      return {
        razorpayOrderId: payment.providerOrderId,
        razorpayPaymentId: providerPaymentId,
        razorpaySignature: signature,
      };
    },

    /**
     * Asks the provider what happened to an order's payment (reconcile job and webhook recovery).
     * Returns the markOrderPaid outcome, or 'none' if no captured payment exists.
     */
    async confirmFromProvider(payment, via) {
      const payments = await paymentProvider.fetchOrderPayments(payment.providerOrderId);
      const captured = payments.find((p) => p.status === 'captured');
      if (!captured) return 'none';
      return this.markOrderPaid({ payment, providerPayment: captured, via });
    },
  };
}
