import { providerError } from './PaymentProvider.js';
import { checkoutSignature, safeEqualHex, webhookSignature } from './signatures.js';

/**
 * MockLedgerProvider (D2 fallback). An in-process stand-in for Razorpay Route: no network, no
 * persistence. It is used for development and for every automated test of Phase 5a-5d.
 *
 * It deliberately enforces the limits Razorpay documents (D45/D47/D57) so that a checkout bug cannot
 * hide behind the mock: INR only, transfers must be at least 100 paise and may not exceed the
 * order amount in total, a transfer is created on hold, and a reversal is at least 100 paise.
 *
 * Test helpers (not part of the PaymentProvider contract): simulatePayment, buildWebhook,
 * buildRefundWebhook, buildTransferWebhook, failNext, setNextRefundStatus, setRefundStatus,
 * settleTransfer, failTransfer, tamperTransfer, state.
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
  const refundsById = new Map(); // providerRefundId -> refund
  const transferStore = new Map(); // providerTransferId -> transfer
  let nextRefundStatus = 'processed';
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

  const viewRefund = (r) => ({
    providerRefundId: r.id,
    id: r.id,
    paymentId: r.paymentId,
    amountPaise: r.amountPaise,
    status: r.status,
  });
  const viewTransfer = (t) => ({
    id: t.id,
    amountPaise: t.amountPaise,
    amountReversedPaise: t.amountReversedPaise,
    status: t.status,
    onHold: t.onHold,
    settlementStatus: t.settlementStatus,
  });
  // A signed webhook request as Razorpay would send it: { rawBody: Buffer, headers }.
  const sign = (body, eventId) => {
    const rawBody = Buffer.from(JSON.stringify(body));
    return {
      rawBody,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': webhookSignature({ rawBody, webhookSecret }),
        'x-razorpay-event-id': eventId,
      },
    };
  };

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
      for (const c of created) {
        transferStore.set(c.providerTransferId, {
          id: c.providerTransferId,
          orderId: providerOrderId,
          linkedAccountId: c.linkedAccountId,
          amountPaise: c.amountPaise,
          amountReversedPaise: 0,
          onHold: true,
          status: 'created',
          settlementStatus: 'on_hold',
        });
      }
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
      if (receipt && refunds.has(receipt)) return viewRefund(refunds.get(receipt)); // replay-safe
      const payment = payments.get(providerPaymentId);
      if (!payment || payment.status !== 'captured') {
        throw providerError('Only a captured payment can be refunded');
      }
      if (reverseAll) {
        // Razorpay: reverse_all recovers the amount of every transfer on the payment first (S4).
        for (const t of transferStore.values()) {
          if (t.orderId === payment.orderId) t.amountReversedPaise = t.amountPaise;
        }
      }
      const refund = {
        id: next('rfnd'),
        paymentId: providerPaymentId,
        amountPaise,
        status: nextRefundStatus,
      };
      payment.refundedPaise = (payment.refundedPaise ?? 0) + amountPaise;
      if (receipt) refunds.set(receipt, refund);
      refundsById.set(refund.id, refund);
      return viewRefund(refund);
    },

    /** PATCH /v1/transfers/:id with on_hold: false (S2). Repeating it is harmless. */
    async releaseTransfer(providerTransferId) {
      record('releaseTransfer', { providerTransferId });
      maybeFail('releaseTransfer');
      const transfer = transferStore.get(providerTransferId);
      if (!transfer) throw providerError('Transfer not found at the provider');
      transfer.onHold = false;
      if (transfer.settlementStatus === 'on_hold') transfer.settlementStatus = 'pending';
      return { providerTransferId };
    },

    /** POST /v1/transfers/:id/reversals (S20): at least INR 1.00, partial and repeated allowed. */
    async reverseTransfer({ providerTransferId, amountPaise, notes }) {
      record('reverseTransfer', { providerTransferId, amountPaise, notes });
      maybeFail('reverseTransfer');
      const transfer = transferStore.get(providerTransferId);
      if (!transfer) throw providerError('Transfer not found at the provider');
      if (!Number.isInteger(amountPaise) || amountPaise < 100) {
        throw providerError('A reversal must be at least INR 1.00');
      }
      // Not a Razorpay rule we have read: a safety net so a bug in OUR refund maths fails loudly.
      if (transfer.amountReversedPaise + amountPaise > transfer.amountPaise) {
        throw providerError('Mock safety net: reversal larger than what is left of the transfer');
      }
      transfer.amountReversedPaise += amountPaise;
      return { providerReversalId: next('rvrsl') };
    },

    /** GET /v1/transfers/:id (S20). */
    async fetchTransfer(providerTransferId) {
      record('fetchTransfer', { providerTransferId });
      maybeFail('fetchTransfer');
      const transfer = transferStore.get(providerTransferId);
      if (!transfer) throw providerError('Transfer not found at the provider');
      return viewTransfer(transfer);
    },

    /** GET /v1/payments/:payment_id/refunds/:refund_id (S21). */
    async fetchRefund({ providerPaymentId, providerRefundId }) {
      record('fetchRefund', { providerPaymentId, providerRefundId });
      maybeFail('fetchRefund');
      const refund = refundsById.get(providerRefundId);
      if (!refund || refund.paymentId !== providerPaymentId) {
        throw providerError('Refund not found at the provider');
      }
      return viewRefund(refund);
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
      return sign(body, eventId);
    },

    /** refund.processed / refund.failed / refund.created as Razorpay sends them (S22). */
    buildRefundWebhook(eventType, { providerRefundId, eventId = next('evt') }) {
      const refund = refundsById.get(providerRefundId);
      const entity = refund
        ? {
            id: refund.id,
            entity: 'refund',
            amount: refund.amountPaise,
            currency: 'INR',
            payment_id: refund.paymentId,
            status: refund.status,
          }
        : { id: providerRefundId, entity: 'refund' };
      return sign(
        {
          entity: 'event',
          account_id: 'acc_mock',
          event: eventType,
          contains: ['refund', 'payment'],
          payload: { refund: { entity } },
        },
        eventId,
      );
    },

    /** transfer.processed / transfer.failed. The payload path is assumption A11. */
    buildTransferWebhook(eventType, { providerTransferId, eventId = next('evt') }) {
      const transfer = transferStore.get(providerTransferId);
      const entity = transfer
        ? {
            id: transfer.id,
            entity: 'transfer',
            amount: transfer.amountPaise,
            status: transfer.status,
            recipient: transfer.linkedAccountId,
          }
        : { id: providerTransferId, entity: 'transfer' };
      return sign(
        {
          entity: 'event',
          account_id: 'acc_mock',
          event: eventType,
          contains: ['transfer'],
          payload: { transfer: { entity } },
        },
        eventId,
      );
    },

    /** Makes the next call to `method` throw PAYMENT_PROVIDER_ERROR (compensation tests). */
    failNext(method) {
      failures.add(method);
    },
    setPaymentStatus(providerPaymentId, status) {
      payments.get(providerPaymentId).status = status;
    },
    /** Refunds created from now on start in this status ('pending' until set to processed). */
    setNextRefundStatus(status) {
      nextRefundStatus = status;
    },
    setRefundStatus(providerRefundId, status) {
      refundsById.get(providerRefundId).status = status;
    },
    /** Razorpay paid the transfer out to the linked account's bank. */
    settleTransfer(providerTransferId) {
      const transfer = transferStore.get(providerTransferId);
      transfer.status = 'processed';
      transfer.settlementStatus = 'settled';
    },
    failTransfer(providerTransferId) {
      transferStore.get(providerTransferId).status = 'failed';
    },
    /** Changes a transfer behind our back: how the tests plant a reconciliation mismatch. */
    tamperTransfer(providerTransferId, changes) {
      Object.assign(transferStore.get(providerTransferId), changes);
    },
    state: { orders, payments, refunds, refundsById, transfers: transferStore, calls },
    secrets: { keySecret, webhookSecret },
  };
}
