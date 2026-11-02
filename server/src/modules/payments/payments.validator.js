import { z } from 'zod';
import { objectId } from '../../lib/pagination.js';

// What Checkout hands the browser after payment (API_CONTRACTS POST /payments/verify).
export const verifyBody = z.strictObject({
  orderId: objectId('order id'),
  razorpayOrderId: z.string().min(1).max(100),
  razorpayPaymentId: z.string().min(1).max(100),
  razorpaySignature: z.string().min(1).max(200),
});

export const mockCompleteBody = z.strictObject({ orderId: objectId('order id') });
