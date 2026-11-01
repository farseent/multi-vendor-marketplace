import mongoose from 'mongoose';

// DATABASE_SCHEMA "couponRedemptions". Phase 4 only READS this collection (to enforce the
// per-user limit); checkout (Phase 5) creates `reserved` rows and payment turns them `redeemed`.
const redemptionSchema = new mongoose.Schema(
  {
    couponId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, required: true }, // ref orders (Phase 5)
    discountPaise: { type: Number, required: true, min: 0, validate: Number.isInteger },
    status: { type: String, enum: ['reserved', 'redeemed', 'released'], required: true },
  },
  { timestamps: true, collection: 'couponRedemptions' },
);

redemptionSchema.index({ couponId: 1, orderId: 1 }, { unique: true });
redemptionSchema.index({ couponId: 1, customerId: 1, status: 1 });

export const CouponRedemption =
  mongoose.models.CouponRedemption ?? mongoose.model('CouponRedemption', redemptionSchema);
