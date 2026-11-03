import { providerError } from './PaymentProvider.js';
import { checkoutSignature, safeEqualHex, webhookSignature } from './signatures.js';

/**
 * The Razorpay Route adapter (DECISIONS D44-D49). A thin layer over Razorpay's REST API using
 * `fetch`; there is no SDK dependency. Every endpoint it calls is listed in the DECISIONS source
 * register (S1, S2, S4, S17-S22).
 *
 * Failures are thrown as PAYMENT_PROVIDER_ERROR (502) with a generic message plus the HTTP status
 * and Razorpay error code. The credentials and Razorpay's free-text descriptions never leave here.
 */
export function createRazorpayProvider({
  keyId,
  keySecret,
  webhookSecret,
  fetchImpl = globalThis.fetch,
  baseUrl = 'https://api.razorpay.com',
  timeoutMs = 10_000,
}) {
  const authorization = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

  async function call(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw providerError('The payment provider could not be reached');
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      // not JSON: handled below
    }
    if (!res.ok) {
      throw providerError('The payment provider rejected the request', {
        providerStatus: res.status,
        providerCode: json?.error?.code ?? null,
      });
    }
    if (json === null) throw providerError('The payment provider answered unexpectedly');
    return json;
  }

  // Razorpay payment entity -> the provider-neutral shape (PaymentProvider.js).
  const toPayment = (p) => ({
    id: p.id,
    orderId: p.order_id,
    amountPaise: p.amount,
    currency: p.currency,
    status: p.status, // created | authorized | captured | refunded | failed
    method: p.method,
  });

  return {
    name: 'razorpay',
    publicKeyId: keyId,

    /** POST /v1/orders with one on-hold transfer per sub-order (D45; S1). */
    async createOrder({ amountPaise, receipt, transfers = [] }) {
      const order = await call('POST', '/v1/orders', {
        amount: amountPaise,
        currency: 'INR',
        receipt,
        transfers: transfers.map((t) => ({
          account: t.linkedAccountId,
          amount: t.amountPaise,
          currency: 'INR',
          notes: t.notes,
          on_hold: true, // no on_hold_until: held until we release it explicitly (Phase 6)
        })),
      });
      const returned = order.transfers ?? [];
      // Match by the recipient account; fall back to request order only if Razorpay omits it.
      const byAccount = new Map(returned.map((t) => [t.recipient, t.id]));
      const matched = transfers.map((t, i) => ({
        linkedAccountId: t.linkedAccountId,
        providerTransferId:
          byAccount.get(t.linkedAccountId) ??
          (byAccount.has(undefined) ? returned[i]?.id : undefined),
      }));
      if (!order.id || matched.some((t) => !t.providerTransferId)) {
        throw providerError('The payment provider answered unexpectedly');
      }
      return { providerOrderId: order.id, transfers: matched };
    },

    /** hmac_sha256(order_id|payment_id, key_secret), hex (D48; S13). */
    verifyCheckoutSignature({ providerOrderId, providerPaymentId, signature }) {
      return safeEqualHex(
        checkoutSignature({ providerOrderId, providerPaymentId, keySecret }),
        signature,
      );
    },

    /** GET /v1/payments/:id (S18). */
    async fetchPayment(providerPaymentId) {
      return toPayment(await call('GET', `/v1/payments/${encodeURIComponent(providerPaymentId)}`));
    },

    /** GET /v1/orders/:id/payments (S17). */
    async fetchOrderPayments(providerOrderId) {
      const res = await call('GET', `/v1/orders/${encodeURIComponent(providerOrderId)}/payments`);
      return (res.items ?? []).map(toPayment);
    },

    /** hmac_sha256(raw body, webhook secret), hex (D46; S7). */
    verifyWebhookSignature(rawBody, signature) {
      return safeEqualHex(webhookSignature({ rawBody, webhookSecret }), signature);
    },

    /**
     * POST /v1/payments/:id/refund (S4). `reverse_all: 1` takes the held vendor transfers back
     * before refunding the customer. Razorpay's `receipt` is only a label, not an idempotency key,
     * so the caller must make sure this is called once per refund (payments.service claims it).
     */
    async refundPayment({ providerPaymentId, amountPaise, reverseAll = false }) {
      const refund = await call(
        'POST',
        `/v1/payments/${encodeURIComponent(providerPaymentId)}/refund`,
        {
          amount: amountPaise,
          reverse_all: reverseAll ? 1 : 0,
        },
      );
      return {
        providerRefundId: refund.id,
        status: refund.status === 'processed' ? 'processed' : 'initiated',
      };
    },

    /** PATCH /v1/transfers/:id with on_hold: false (S2). Setting it again is harmless. */
    async releaseTransfer(providerTransferId) {
      const transfer = await call(
        'PATCH',
        `/v1/transfers/${encodeURIComponent(providerTransferId)}`,
        {
          on_hold: false,
        },
      );
      return { providerTransferId: transfer.id ?? providerTransferId };
    },

    /**
     * POST /v1/transfers/:id/reversals (S20): takes `amount` back from the linked account into
     * ours. Partial and repeated reversals are allowed; the minimum is INR 1.00. Razorpay has no
     * idempotency key for it, so the caller keeps the returned id and never repeats a done step.
     */
    async reverseTransfer({ providerTransferId, amountPaise, notes }) {
      const reversal = await call(
        'POST',
        `/v1/transfers/${encodeURIComponent(providerTransferId)}/reversals`,
        { amount: amountPaise, notes },
      );
      if (!reversal.id) throw providerError('The payment provider answered unexpectedly');
      return { providerReversalId: reversal.id };
    },

    /** GET /v1/transfers/:id (S20): amount, amount_reversed, status, on_hold, settlement_status. */
    async fetchTransfer(providerTransferId) {
      const t = await call('GET', `/v1/transfers/${encodeURIComponent(providerTransferId)}`);
      return {
        id: t.id,
        amountPaise: t.amount,
        amountReversedPaise: t.amount_reversed ?? 0,
        status: t.status, // created | pending | processed | failed | reversed | partially_reversed
        onHold: Boolean(t.on_hold),
        settlementStatus: t.settlement_status, // pending | on_hold | settled
      };
    },

    /** GET /v1/payments/:payment_id/refunds/:refund_id (S21). */
    async fetchRefund({ providerPaymentId, providerRefundId }) {
      const refund = await call(
        'GET',
        `/v1/payments/${encodeURIComponent(providerPaymentId)}/refunds/${encodeURIComponent(providerRefundId)}`,
      );
      return {
        id: refund.id,
        providerRefundId: refund.id,
        paymentId: refund.payment_id,
        amountPaise: refund.amount,
        status:
          refund.status === 'processed'
            ? 'processed'
            : refund.status === 'failed'
              ? 'failed'
              : 'pending',
      };
    },

    /** A vendor can be paid only with an attached, active linked account (D49). */
    async resolvePayoutAccount(vendor) {
      const account = vendor.payoutAccount;
      return {
        linkedAccountId: account?.linkedAccountId ?? null,
        active: Boolean(account?.linkedAccountId) && account?.status === 'active',
      };
    },

    /**
     * GET /v2/accounts/:id (S19): the account must exist under this merchant (Razorpay answers 400
     * otherwise), be a Route account and not be suspended. Whether Route is ACTIVATED for the
     * account is a separate product-configuration resource that needs a product id we do not
     * store, so it is not checked here (HANDOVER, known issue); a non-activated account shows up
     * as a provider error when an order is created.
     */
    async validateLinkedAccount({ linkedAccountId }) {
      let account;
      try {
        account = await call('GET', `/v2/accounts/${encodeURIComponent(linkedAccountId)}`);
      } catch (err) {
        if (err.details?.providerStatus === 400)
          return { ok: false, reason: 'not_found_or_not_yours' };
        throw err;
      }
      if (account.type !== 'route') return { ok: false, reason: 'not_a_route_account' };
      if (account.status === 'suspended') return { ok: false, reason: 'suspended' };
      return { ok: true };
    },
  };
}
