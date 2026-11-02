import { describe, expect, it } from 'vitest';
import {
  buildCheckoutOptions,
  canReuseKey,
  checkoutErrorMessage,
  formatCountdown,
  newIdempotencyKey,
  orderStatusLabel,
  secondsLeft,
  toVerifyBody,
} from './checkout.js';

// The API's rule for the Idempotency-Key header (server/src/config/constants.js IDEMPOTENCY_KEY).
const API_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,100}$/;

describe('newIdempotencyKey', () => {
  it('produces keys the API accepts, and a new one each time', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(50);
    for (const key of keys) expect(key).toMatch(API_KEY_PATTERN);
  });

  it('still works without crypto.randomUUID', () => {
    const key = newIdempotencyKey({ getRandomValues: (a) => a.fill(171) });
    expect(key).toMatch(API_KEY_PATTERN);
    expect(newIdempotencyKey(null)).toMatch(API_KEY_PATTERN);
  });
});

describe('canReuseKey', () => {
  it('reuses the key only when the answer never arrived', () => {
    expect(canReuseKey({ code: 'NETWORK_ERROR' })).toBe(true);
    for (const code of [
      'OUT_OF_STOCK',
      'PAYMENT_PROVIDER_ERROR',
      'COUPON_INVALID',
      'VALIDATION_ERROR',
    ]) {
      expect(canReuseKey({ code })).toBe(false);
    }
    expect(canReuseKey(undefined)).toBe(false);
  });
});

describe('checkoutErrorMessage', () => {
  const msg = (code, reason, message = 'server text') =>
    checkoutErrorMessage({ code, message, details: reason ? { reason } : undefined });

  it('has a specific message for every documented checkout rejection', () => {
    const generic = 'Something went wrong.';
    const cases = [
      ['OUT_OF_STOCK'],
      ['COUPON_INVALID', 'exceeds_platform_margin'],
      ['VALIDATION_ERROR', 'zero_total'],
      ['VALIDATION_ERROR', 'below_minimum_total'],
      ['VALIDATION_ERROR', 'payout_below_minimum'],
      ['VALIDATION_ERROR', 'empty_cart'],
      ['CONFLICT', 'vendor_payout_unavailable'],
      ['CONFLICT', 'unavailable'],
      ['PAYMENT_PROVIDER_ERROR'],
      ['PAYMENT_VERIFICATION_FAILED'],
      ['NETWORK_ERROR'],
    ];
    const seen = new Set();
    for (const [code, reason] of cases) {
      const text = msg(code, reason);
      expect(text, `${code}/${reason}`).not.toBe('server text');
      expect(text).not.toBe(generic);
      seen.add(text);
    }
    expect(seen.size).toBe(cases.length); // no two reasons share a message
  });

  it('every coupon reason the API can send has its own message', () => {
    const reasons = [
      'not_found',
      'disabled',
      'not_started',
      'expired',
      'wrong_vendor',
      'below_min_order',
      'total_limit_reached',
      'user_limit_reached',
      'exceeds_platform_margin',
    ];
    const fallback = msg('COUPON_INVALID', 'something_new');
    for (const reason of reasons) expect(msg('COUPON_INVALID', reason), reason).not.toBe(fallback);
  });

  it('falls back to the server message, then a generic one, for anything else', () => {
    expect(msg('VALIDATION_ERROR', 'unknown_reason', 'Invalid request')).toBe('Invalid request');
    expect(msg('CONFLICT', undefined, 'Try again later')).toBe('Try again later');
    expect(checkoutErrorMessage({ code: 'WHATEVER', message: 'Boom' })).toBe('Boom');
    expect(checkoutErrorMessage(undefined)).toBe('Something went wrong.');
  });
});

describe('orderStatusLabel', () => {
  it.each([
    [{ status: 'pending_payment', paymentStatus: 'unpaid' }, 'Waiting for payment'],
    [{ status: 'placed', paymentStatus: 'paid' }, 'Paid'],
    [{ status: 'completed', paymentStatus: 'paid' }, 'Completed'],
    [
      { status: 'expired', paymentStatus: 'unpaid', refundStatus: 'none' },
      'Expired: payment was not completed in time',
    ],
    [
      { status: 'expired', paymentStatus: 'paid', refundStatus: 'full' },
      'Expired: your payment arrived too late and was refunded in full',
    ],
    [{ status: 'cancelled' }, 'Cancelled'],
  ])('%j -> %s', (order, label) => expect(orderStatusLabel(order)).toBe(label));
});

describe('reservation countdown', () => {
  it('counts down and never goes below zero', () => {
    const now = Date.parse('2026-11-01T10:00:00Z');
    expect(secondsLeft('2026-11-01T10:15:00Z', now)).toBe(900);
    expect(secondsLeft('2026-11-01T10:00:00.400Z', now)).toBe(1);
    expect(secondsLeft('2026-11-01T09:59:00Z', now)).toBe(0);
    expect(secondsLeft(undefined, now)).toBe(0);
  });

  it('formats minutes and seconds', () => {
    expect(formatCountdown(754)).toBe('12:34');
    expect(formatCountdown(65)).toBe('1:05');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-5)).toBe('0:00');
  });
});

describe('payment hand-off', () => {
  it('maps Razorpay Checkout’s response, and the mock’s, to the /payments/verify body', () => {
    const body = {
      orderId: 'o1',
      razorpayOrderId: 'order_1',
      razorpayPaymentId: 'pay_1',
      razorpaySignature: 'sig',
    };
    expect(
      toVerifyBody('o1', {
        razorpay_order_id: 'order_1',
        razorpay_payment_id: 'pay_1',
        razorpay_signature: 'sig',
      }),
    ).toEqual(body);
    expect(
      toVerifyBody('o1', {
        razorpayOrderId: 'order_1',
        razorpayPaymentId: 'pay_1',
        razorpaySignature: 'sig',
      }),
    ).toEqual(body);
  });

  it('builds Checkout options from the server’s answer only, with no secret', () => {
    const payment = {
      keyId: 'rzp_test_abc',
      providerOrderId: 'order_9',
      amountPaise: 150000,
      currency: 'INR',
    };
    const onPaid = () => {};
    const onDismiss = () => {};
    const options = buildCheckoutOptions({
      payment,
      order: { orderNumber: 'MP-1' },
      user: { name: 'Asha', email: 'a@example.com' },
      onPaid,
      onDismiss,
    });
    expect(options).toMatchObject({
      key: 'rzp_test_abc',
      order_id: 'order_9',
      amount: 150000,
      currency: 'INR',
      handler: onPaid,
      modal: { ondismiss: onDismiss },
    });
    expect(options.description).toContain('MP-1');
    expect(JSON.stringify(Object.keys(options))).not.toMatch(/secret/i);
  });
});
