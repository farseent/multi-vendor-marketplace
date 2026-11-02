import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The two Razorpay signature schemes (DECISIONS D46 and D48). Both providers use them, so the
 * mock exercises exactly the code the real adapter runs.
 */
export const hmacSha256Hex = (key, message) =>
  createHmac('sha256', key).update(message).digest('hex');

/** Constant-time comparison of two hex strings; false for anything malformed or of another length. */
export function safeEqualHex(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  if (!/^[0-9a-f]+$/i.test(received) || expected.length !== received.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
}

/** Checkout callback: hmac_sha256(order_id + "|" + payment_id, key_secret), hex (D48). */
export const checkoutSignature = ({ providerOrderId, providerPaymentId, keySecret }) =>
  hmacSha256Hex(keySecret, `${providerOrderId}|${providerPaymentId}`);

/** Webhook: hmac_sha256(raw request body, webhook_secret), hex (D46). `rawBody` is a Buffer. */
export const webhookSignature = ({ rawBody, webhookSecret }) =>
  hmacSha256Hex(webhookSecret, rawBody);
