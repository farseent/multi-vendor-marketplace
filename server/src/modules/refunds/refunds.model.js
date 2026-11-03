import mongoose from 'mongoose';
import { REFUND_REASONS } from '../../config/constants.js';
import { paise, toJSON } from '../../lib/modelJson.js';

const { ObjectId } = mongoose.Schema.Types;

// DATABASE_SCHEMA "refunds". Phase 5 wrote only `failed_late_capture` refunds (a payment captured
// after its order expired and the stock was gone): they cover the whole order, so `subOrderId` is
// optional, and the system requests them, so `requestedBy` is optional. Phase 6 adds the
// per-sub-order refunds (customer cancel, vendor cancel, admin) and two fields, recorded in D57:
// the reason `vendor_cancel` and `providerReversalId` (the transfer reversal made for this refund).
const refundSchema = new mongoose.Schema(
  {
    paymentId: { type: ObjectId, ref: 'Payment', required: true },
    orderId: { type: ObjectId, ref: 'Order', required: true },
    subOrderId: { type: ObjectId, ref: 'SubOrder' },
    amountPaise: paise,
    commissionReversedPaise: { type: Number, default: 0, min: 0, validate: Number.isInteger },
    vendorDebitPaise: { type: Number, default: 0, min: 0, validate: Number.isInteger },
    reason: { type: String, enum: REFUND_REASONS, required: true },
    note: String,
    status: { type: String, enum: ['initiated', 'processed', 'failed'], default: 'initiated' },
    providerRefundId: String,
    // The vendor's transfer is reversed BEFORE the customer is refunded (D57). Kept on the row so a
    // retry after a crash or a provider error never reverses the same refund twice.
    providerReversalId: String,
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
