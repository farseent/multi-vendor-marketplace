import mongoose from 'mongoose';

// Append-only record of who changed what. Written by every admin mutation (ARCHITECTURE 6).
const auditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    actorRole: { type: String, required: true },
    action: { type: String, required: true }, // e.g. "vendor.status_changed"
    entityType: { type: String, required: true }, // e.g. "vendor"
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
    meta: mongoose.Schema.Types.Mixed,
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'auditLogs' },
);

auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

export const AuditLog = mongoose.models.AuditLog ?? mongoose.model('AuditLog', auditLogSchema);
