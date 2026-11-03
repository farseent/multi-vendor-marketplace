import mongoose from 'mongoose';
import { toJSON } from '../../lib/modelJson.js';

const { ObjectId } = mongoose.Schema.Types;

// DATABASE_SCHEMA "reconciliationReports": one document per run (ARCHITECTURE 3.5). `mismatches` is
// capped (RECONCILIATION_JOB.maxStoredMismatches); `totals.mismatchCount` always has the true number.
const mismatchSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    entityType: { type: String, enum: ['settlement', 'refund'], required: true },
    settlementId: ObjectId,
    refundId: ObjectId,
    subOrderId: ObjectId,
    providerTransferId: String,
    expected: mongoose.Schema.Types.Mixed,
    actual: mongoose.Schema.Types.Mixed,
    detail: String,
  },
  { _id: false },
);

const reconciliationSchema = new mongoose.Schema(
  {
    runAt: { type: Date, required: true },
    status: { type: String, enum: ['ok', 'mismatch'], required: true },
    trigger: { type: String, enum: ['job', 'admin'], required: true },
    triggeredBy: { type: ObjectId, ref: 'User' },
    totals: { type: mongoose.Schema.Types.Mixed, required: true },
    mismatches: { type: [mismatchSchema], default: [] },
  },
  { timestamps: true, toJSON, collection: 'reconciliationReports' },
);

reconciliationSchema.index({ runAt: -1 });

export const ReconciliationReport =
  mongoose.models.ReconciliationReport ??
  mongoose.model('ReconciliationReport', reconciliationSchema);
