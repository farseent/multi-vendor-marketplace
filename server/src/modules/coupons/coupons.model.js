import mongoose from 'mongoose';
import { COUPON } from '../../config/constants.js';

const toJSON = {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret) {
    delete ret._id;
    return ret;
  },
};

const isInt = { validator: Number.isInteger, message: 'Must be a whole number' };

// Field rules follow DATABASE_SCHEMA "coupons". Cross-field rules (percent 1-90, fixed >= 100 paise,
// expiresAt > startsAt, vendor scope needs vendorId) live in coupons.rules.js so the service can
// answer 422 with `body.<field>` paths; the schema keeps the simple per-field guards.
const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: /^[A-Z0-9_-]{4,20}$/,
    },
    scope: { type: String, enum: COUPON.scopes, required: true },
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' }, // vendor scope only
    fundedBy: { type: String, enum: ['platform', 'vendor'], required: true },
    type: { type: String, enum: COUPON.types, required: true },
    // percent: 1-90 (whole percent). fixed: paise.
    value: { type: Number, required: true, min: 1, validate: isInt },
    minOrderPaise: { type: Number, default: 0, min: 0, validate: isInt },
    maxDiscountPaise: { type: Number, min: 1, validate: isInt }, // percent coupons only
    startsAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    usageLimitTotal: { type: Number, min: 1, validate: isInt }, // unset = unlimited
    usageLimitPerUser: { type: Number, default: 1, min: 1, validate: isInt },
    // Incremented atomically when checkout reserves the coupon (Phase 5). Never edited by hand.
    usedCount: { type: Number, default: 0, min: 0, validate: isInt },
    status: { type: String, enum: COUPON.statuses, default: 'active' },
  },
  { timestamps: true, toJSON },
);

couponSchema.index({ code: 1 }, { unique: true });
couponSchema.index({ vendorId: 1 });

export const Coupon = mongoose.models.Coupon ?? mongoose.model('Coupon', couponSchema);
