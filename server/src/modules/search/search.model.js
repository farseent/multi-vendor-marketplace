import mongoose from 'mongoose';

// Transactional outbox (D11): written in the SAME transaction as the product change, so a change
// can never be lost because Elasticsearch was down. `op` is a hint for humans reading the
// collection; the sync job always re-reads the product, so stale entries are harmless.
const searchOutboxSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    op: { type: String, enum: ['upsert', 'delete'], default: 'upsert' },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    lastError: String,
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'searchOutbox',
  },
);

searchOutboxSchema.index({ nextAttemptAt: 1 });
searchOutboxSchema.index({ productId: 1 });

export const SearchOutbox =
  mongoose.models.SearchOutbox ?? mongoose.model('SearchOutbox', searchOutboxSchema);