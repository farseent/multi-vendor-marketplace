import mongoose from 'mongoose';
import { WEBHOOK_STALE_CLAIM_MS } from '../../config/constants.js';
import { paise, toJSON } from '../../lib/modelJson.js';

const { ObjectId } = mongoose.Schema.Types;

// DATABASE_SCHEMA "payments". Two differences, both recorded in HANDOVER:
//  - `provider` also allows 'mock' (the MockLedger), so test payments are not labelled razorpay;
//  - `providerOrderId` is unique but SPARSE: the payment row is written inside the checkout
//    transaction, while the provider order is created after the commit (ARCHITECTURE 3.1).
const paymentSchema = new mongoose.Schema(
  {
    orderId: { type: ObjectId, ref: 'Order', required: true },
    provider: { type: String, enum: ['razorpay', 'mock'], required: true },
    providerOrderId: String,
    providerPaymentId: String,
    amountPaise: paise,
    currency: { type: String, enum: ['INR'], default: 'INR' },
    status: {
      type: String,
      enum: ['created', 'authorized', 'captured', 'failed'],
      default: 'created',
    },
    method: String,
    failureReason: String,
    capturedAt: Date,
    confirmedVia: { type: String, enum: ['client_verify', 'webhook', 'reconcile'] },
  },
  { timestamps: true, toJSON },
);

paymentSchema.index({ providerOrderId: 1 }, { unique: true, sparse: true });
paymentSchema.index({ providerPaymentId: 1 }, { unique: true, sparse: true });
paymentSchema.index({ orderId: 1 });

// DATABASE_SCHEMA "webhookEvents" + `claimedAt` (D46): when a handler last took ownership of the
// event. `eventId` is the x-razorpay-event-id header, never a field of the body.
const webhookEventSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true },
    eventId: { type: String, required: true },
    eventType: { type: String, required: true },
    status: {
      type: String,
      enum: ['received', 'processed', 'failed', 'ignored'],
      default: 'received',
    },
    attempts: { type: Number, default: 1 },
    receivedAt: { type: Date, default: () => new Date() },
    claimedAt: { type: Date, default: () => new Date() },
    processedAt: Date,
    error: String,
  },
  { collection: 'webhookEvents', versionKey: false },
);

webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
webhookEventSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 }); // TTL 90 days
webhookEventSchema.index({ status: 1, claimedAt: 1 }); // the reconcile job's lookup

export const STALE_CLAIM_MS = WEBHOOK_STALE_CLAIM_MS;
export const Payment = mongoose.models.Payment ?? mongoose.model('Payment', paymentSchema);
export const WebhookEvent =
  mongoose.models.WebhookEvent ?? mongoose.model('WebhookEvent', webhookEventSchema);
