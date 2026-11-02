import { providerError } from './PaymentProvider.js';
import { checkoutSignature, safeEqualHex, webhookSignature } from './signatures.js';

/**
 * MockLedgerProvider (D2 fallback). An in-process stand-in for Razorpay Route: no network, no
 * persistence. It is used for development and for every automated test of Phase 5a-5d.
 *
 * It deliberately enforces the limits Razorpay documents (D45/D47) so that a checkout bug cannot
 * hide behind the mock: INR only, transfers must be at least 100 paise and may not exceed the
 * order amount in total, and a transfer is created on hold.
 *
 * Test helpers (not part of the PaymentProvider contract): simulatePayment, buildWebhook,
 * failNext, state.
 */
export function createMockLedger({
  keySecret = 'mock-key-secret',
  webhookSecret = 'mock-webhook-secret',
  publicKeyId = 'rzp_test_mock',
} = {}) {
  let seq = 0;
  const next = (prefix) => `${prefix}_mock_${String(++seq).padStart(6, '0')}`;
  const orders = new Map(); // providerOrderId -> { id, amountPaise, receipt, transfers }
  const payments = new Map(); // providerPaymentId -> payment
  const refunds = new Map(); // receipt -> refund
  const failures = new Set(); // method names that fail once
  const calls = []; // [{ method, args }] for assertions

  const record = (method, args) => calls.push({ method, args });
  const maybeFail = (method) => {
    if (failures.delete(method)) throw providerError(`Mock provider failed: ${method}`);
  };
  const view = (p) => ({
    id: p.id,
    orderId: p.orderId,
    amountPaise: p.amountPaise,
    currency: 'INR',
    status: p.status,
    method: p.method,
  });

  return {
    name: 'mock',
    publicKeyId,

    async createOrder({ amountPaise, receipt, transfers = [] }) {
      record('createOrder', { amountPaise, receipt, transfers });
      maybeFail('createOrder');
      if (!Number.isInteger(amountPaise) || amountPaise < 100) {
        throw providerError('The amount must be at least INR 1.00');
      }
      let sum = 0;
      for (const t of transfers) {
        if (!t.linkedAccountId) throw providerError('Transfer needs a linked account');
        if (!Number.isInteger(t.amountPaise) || t.amountPaise < 100) {
          throw providerError('A transfer must be at least INR 1.00');
        }
        sum += t.amountPaise;
      }
      if (sum > amountPaise) {
        throw providerError('The sum of amount requested for transfer is greater than the amount');
      }
      const providerOrderId = next('order');
      const created = transfers.map((t) => ({
        linkedAccountId: t.linkedAccountId,
        providerTransferId: next('trf'),
        amountPaise: t.amountPaise,
        onHold: true, // D45: always created on hold, released explicitly later
      }));
      orders.set(providerOrderId, {
        id: providerOrderId,
        amountPaise,
        receipt,
        transfers: created,
      });
      return {
        providerOrderId,
        transfers: created.map(({ linkedAccountId, providerTransferId }) => ({
          linkedAccountId,
          providerTransferId,
        })),
      };
    },

    verifyCheckoutSignature({ providerOrderId, providerPaymentId, signature }) {
      return safeEqualHex(
        checkoutSignature({ providerOrderId, providerPaymentId, keySecret }),
        signature,
      );
    },

    async fetchPayment(providerPaymentId) {
      record('fetchPayment', { providerPaymentId });
      maybeFail('fetchPayment');
      const payment = payments.get(providerPaymentId);
      if (!payment) throw providerError('Payment not found at the provider');
      return view(payment);
    },

    async fetchOrderPayments(providerOrderId) {
      record('fetchOrderPayments', { providerOrderId });
      maybeFail('fetchOrderPayments');
      return [...payments.values()].filter((p) => p.orderId === providerOrderId).map(view);
    },

    verifyWebhookSignature(rawBody, signature) {
      return safeEqualHex(webhookSignature({ rawBody, webhookSecret }), signature);
    },

    async refundPayment({ providerPaymentId, amountPaise, reverseAll = false, receipt }) {
      record('refundPayment', { providerPaymentId, amountPaise, reverseAll, receipt });
      maybeFail('refundPayment');
      if (receipt && refunds.has(receipt)) return refunds.get(receipt); // replay-safe
      const payment = payments.get(providerPaymentId);
      if (!payment || payment.status !== 'captured') {
        throw providerError('Only a captured payment can be refunded');
      }
      const refund = { providerRefundId: next('rfnd'), status: 'processed', amountPaise };
      payment.refundedPaise = (payment.refundedPaise ?? 0) + amountPaise;
      if (receipt) refunds.set(receipt, refund);
      return refund;
    },

    // D49: the mock derives a deterministic account per vendor and stores nothing on the vendor.
    async resolvePayoutAccount(vendor) {
      return { linkedAccountId: `acc_mock${vendor.id}`, active: true };
    },
    async validateLinkedAccount({ vendor, linkedAccountId }) {
      return linkedAccountId === `acc_mock${vendor.id}`
        ? { ok: true }
        : { ok: false, reason: 'unknown_account' };
    },

    // ---------------- test and demo helpers ----------------
    /**
     * Pretends the customer paid in the widget. Returns what Checkout would hand to the browser:
     * { providerPaymentId, signature }. `amountPaise` lets a test simulate a tampered amount.
     */
    simulatePayment(providerOrderId, { amountPaise, status = 'captured', method = 'upi' } = {}) {
      const order = orders.get(providerOrderId);
      if (!order) throw providerError('Order not found at the provider');
      const id = next('pay');
      payments.set(id, {
        id,
        orderId: providerOrderId,
        amountPaise: amountPaise ?? order.amountPaise,
        status,
        method,
      });
      return {
        providerPaymentId: id,
        signature: checkoutSignature({ providerOrderId, providerPaymentId: id, keySecret }),
      };
    },

    /** A signed webhook request as Razorpay would send it: { rawBody: Buffer, headers }. */
    buildWebhook(eventType, { providerOrderId, providerPaymentId, eventId = next('evt') }) {
      const payment = payments.get(providerPaymentId);
      const entity = payment
        ? {
            id: payment.id,
            entity: 'payment',
            order_id: providerOrderId,
            amount: payment.amountPaise,
            currency: 'INR',
            status: payment.status,
            method: payment.method,
          }
        : { id: providerPaymentId, entity: 'payment', order_id: providerOrderId };
      const body = {
        entity: 'event',
        account_id: 'acc_mock',
        event: eventType,
        contains: eventType === 'order.paid' ? ['payment', 'order'] : ['payment'],
        payload: {
          payment: { entity },
          ...(eventType === 'order.paid' && {
            order: { entity: { id: providerOrderId, entity: 'order', status: 'paid' } },
          }),
        },
      };
      const rawBody = Buffer.from(JSON.stringify(body));
      return {
        rawBody,
        headers: {
          'content-type': 'application/json',
          'x-razorpay-signature': webhookSignature({ rawBody, webhookSecret }),
          'x-razorpay-event-id': eventId,
        },
      };
    },

    /** Makes the next call to `method` throw PAYMENT_PROVIDER_ERROR (compensation tests). */
    failNext(method) {
      failures.add(method);
    },
    setPaymentStatus(providerPaymentId, status) {
      payments.get(providerPaymentId).status = status;
    },
    state: { orders, payments, refunds, calls },
    secrets: { keySecret, webhookSecret },
  };
}
