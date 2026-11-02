import { createMockLedger } from './mockLedger.js';
import { assertPaymentProvider } from './PaymentProvider.js';
import { createRazorpayProvider } from './razorpay.js';

/** Builds the provider chosen by PAYMENT_PROVIDER (validated in config/env.js). */
export function createPaymentProvider(env, options = {}) {
  const provider =
    env.PAYMENT_PROVIDER === 'razorpay'
      ? createRazorpayProvider({
          keyId: env.RAZORPAY_KEY_ID,
          keySecret: env.RAZORPAY_KEY_SECRET,
          webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
          ...options,
        })
      : createMockLedger();
  return assertPaymentProvider(provider);
}
