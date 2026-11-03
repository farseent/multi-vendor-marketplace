import mongoose from 'mongoose';
import { REVIEW, REVIEW_STATUSES } from '../../config/constants.js';
import { toJSON } from '../../lib/modelJson.js';

const { ObjectId } = mongoose.Schema.Types;

const reviewSchema = new mongoose.Schema(
  {
    productId: { type: ObjectId, ref: 'Product', required: true },
    vendorId: { type: ObjectId, ref: 'Vendor', required: true },
    customerId: { type: ObjectId, ref: 'User', required: true },
    // The delivered sub-order that made this review eligible (proof of purchase).
    subOrderId: { type: ObjectId, ref: 'SubOrder', required: true },
    rating: { type: Number, required: true, min: 1, max: 5, validate: Number.isInteger },
    title: { type: String, trim: true, maxlength: REVIEW.titleMax },
    body: {
      type: String,
      required: true,
      trim: true,
      minlength: REVIEW.bodyMin,
      maxlength: REVIEW.bodyMax,
    },
    status: { type: String, enum: REVIEW_STATUSES, default: 'published' },
  },
  { timestamps: true, toJSON },
);

// One review per customer per product (acceptance: a second one is 409).
reviewSchema.index({ customerId: 1, productId: 1 }, { unique: true });
reviewSchema.index({ productId: 1, status: 1, createdAt: -1 });

export const Review = mongoose.models.Review ?? mongoose.model('Review', reviewSchema);
