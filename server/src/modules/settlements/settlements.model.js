import mongoose from 'mongoose';
import { paise, toJSON } from '../../lib/modelJson.js';

const { ObjectId } = mongoose.Schema.Types;

// DATABASE_SCHEMA "settlements". Phase 5 only creates them (state `not_eligible`) inside the
// checkout transaction and stores the provider transfer id; Phase 6 owns the state machine.
const settlementSchema = new mongoose.Schema(
  {
    subOrderId: { type: ObjectId, ref: 'SubOrder', required: true },
    orderId: { type: ObjectId, ref: 'Order', required: true },
    vendorId: { type: ObjectId, ref: 'Vendor', required: true },
    grossPaise: paise, // vendor base before commission
    commissionPaise: paise,
    refundAdjustmentPaise: { type: Number, default: 0, min: 0, validate: Number.isInteger },
    netPayoutPaise: paise, // gross - commission - refundAdjustment, floor 0
    status: {
      type: String,
      enum: ['not_eligible', 'pending_release', 'released', 'settled', 'reversed', 'failed'],
      default: 'not_eligible',
    },
    providerTransferId: String,
    eligibleAt: Date,
    releasedAt: Date,
    settledAt: Date,
    failureReason: String,
  },
  { timestamps: true, toJSON },
);

settlementSchema.index({ subOrderId: 1 }, { unique: true });
settlementSchema.index({ vendorId: 1, status: 1, createdAt: -1 });
settlementSchema.index({ status: 1, eligibleAt: 1 });

export const Settlement =
  mongoose.models.Settlement ?? mongoose.model('Settlement', settlementSchema);
