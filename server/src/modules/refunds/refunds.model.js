import mongoose from 'mongoose';
import { paise, toJSON } from '../../lib/modelJson.js';

const { ObjectId } = mongoose.Schema.Types;

// DATABASE_SCHEMA "refunds". Phase 5 writes only `failed_late_capture` refunds (a payment captured
// after its order expired and the stock was gone). Two differences from the schema, recorded in
// HANDOVER: such a refund covers the whole order, so `subOrderId` is optional; and the system, not
// a user, requests it, so `requestedBy` is optional. Phase 6 adds the per-sub-order flows.
const refundSchema = new mongoose.Schema(
  {
    paymentId: { type: ObjectId, ref: 'Payment', required: true },
    orderId: { type: ObjectId, ref: 'Order', required: true },
    subOrderId: { type: ObjectId, ref: 'SubOrder' },
    amountPaise: paise,
    commissionReversedPaise: { type: Number, default: 0, min: 0, validate: Number.isInteger },
    vendorDebitPaise: { type: Number, default: 0, min: 0, validate: Number.isInteger },
    reason: {
      type: String,
      enum: ['customer_cancel', 'admin', 'failed_late_capture'],
      required: true,
    },
    note: String,
    status: { type: String, enum: ['initiated', 'processed', 'failed'], default: 'initiated' },
    providerRefundId: String,
    // When a caller last took ownership of the provider call (atomic claim, so two racing callers
    // never both ask the provider to refund). Not in DATABASE_SCHEMA; recorded in HANDOVER.
    providerCallAt: Date,
    requestedBy: { type: ObjectId, ref: 'User' },
    idempotencyKey: { type: String, required: true },
  },
  { timestamps: true, toJSON },
);

refundSchema.index({ subOrderId: 1 });
refundSchema.index({ providerRefundId: 1 }, { unique: true, sparse: true });
refundSchema.index({ idempotencyKey: 1 }, { unique: true });
refundSchema.index({ orderId: 1 });

export const Refund = mongoose.models.Refund ?? mongoose.model('Refund', refundSchema);
