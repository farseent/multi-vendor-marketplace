import mongoose from 'mongoose';
import { MAX_COMMISSION_BPS, VENDOR_STATUSES } from '../../config/constants.js';

// The collection is `vendors` (DATABASE_SCHEMA); the module is called "shops" (PROJECT_MASTER).
const toJSON = {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret) {
    delete ret._id;
    return ret;
  },
};

const payoutAccountSchema = new mongoose.Schema(
  {
    provider: { type: String, enum: ['razorpay'], default: 'razorpay' },
    linkedAccountId: String,
    status: {
      type: String,
      enum: ['not_created', 'pending', 'active', 'failed'],
      default: 'not_created',
    },
    bankLast4: { type: String, match: /^\d{4}$/ }, // never the full bank number
  },
  { _id: false },
);

const vendorSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    shopName: { type: String, required: true, trim: true, minlength: 3, maxlength: 60 },
    shopSlug: { type: String, required: true, lowercase: true, trim: true },
    description: { type: String, trim: true, maxlength: 1000 },
    logoKey: { type: String, trim: true },
    status: { type: String, enum: VENDOR_STATUSES, default: 'pending' },
    // null = "use the category/platform default" (DECISIONS D6)
    commissionRateBps: {
      type: Number,
      default: null,
      min: 0,
      max: MAX_COMMISSION_BPS,
      validate: [(v) => v === null || Number.isInteger(v), 'Must be an integer'],
    },
    payoutAccount: { type: payoutAccountSchema, default: () => ({}) },
  },
  { timestamps: true, toJSON },
);

vendorSchema.index({ userId: 1 }, { unique: true });
vendorSchema.index({ shopSlug: 1 }, { unique: true });
vendorSchema.index({ status: 1 });

export const Vendor = mongoose.models.Vendor ?? mongoose.model('Vendor', vendorSchema);
