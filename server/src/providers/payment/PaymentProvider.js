import { AppError } from '../../lib/AppError.js';

/**
 * The payment-provider contract (ARCHITECTURE 1, PROJECT_MASTER 4). The rest of the app talks only
 * to this shape, so Razorpay and the MockLedger are interchangeable.
 *
 *   name                     'razorpay' | 'mock'
 *   publicKeyId              the public key the browser widget needs (never a secret)
 *   createOrder({ amountPaise, receipt, transfers })
 *       transfers: [{ linkedAccountId, amountPaise, notes }], one per sub-order, created ON HOLD (D45)
 *       -> { providerOrderId, transfers: [{ linkedAccountId, providerTransferId }] }
 *   verifyCheckoutSignature({ providerOrderId, providerPaymentId, signature }) -> boolean   (D48)
 *   fetchPayment(providerPaymentId)
 *       -> { id, orderId, amountPaise, currency, status, method }   status: created|authorized|captured|refunded|failed
 *   fetchOrderPayments(providerOrderId) -> [ same shape as fetchPayment ]
 *   verifyWebhookSignature(rawBody: Buffer, signature) -> boolean                           (D46)
 *   refundPayment({ providerPaymentId, amountPaise, reverseAll, receipt })
 *       -> { providerRefundId, status: 'initiated' | 'processed' }
 *   resolvePayoutAccount(vendor) -> { linkedAccountId, active }                             (D49)
 *   validateLinkedAccount({ vendor, linkedAccountId }) -> { ok: boolean, reason?: string }  (D49)
 *
 * Every failure of the provider itself is thrown as AppError('PAYMENT_PROVIDER_ERROR', 502).
 */
export const PAYMENT_PROVIDER_METHODS = [
  'createOrder',
  'verifyCheckoutSignature',
  'fetchPayment',
  'fetchOrderPayments',
  'verifyWebhookSignature',
  'refundPayment',
  'resolvePayoutAccount',
  'validateLinkedAccount',
];

export function assertPaymentProvider(provider) {
  const missing = PAYMENT_PROVIDER_METHODS.filter((m) => typeof provider?.[m] !== 'function');
  if (missing.length || !provider?.name || !provider?.publicKeyId) {
    throw new Error(
      `Invalid payment provider: missing ${missing.join(', ') || 'name/publicKeyId'}`,
    );
  }
  return provider;
}

export const providerError = (message, details) =>
  new AppError('PAYMENT_PROVIDER_ERROR', 502, message, details);
