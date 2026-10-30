import mongoose from 'mongoose';
import { MAX_COMMISSION_BPS } from '../../config/constants.js';

const toJSON = {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret) {
    delete ret._id;
    return ret;
  },
};

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 60 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
    // null = fall through to the platform default (DECISIONS D6)
    defaultCommissionBps: {
      type: Number,
      default: null,
      min: 0,
      max: MAX_COMMISSION_BPS,
      validate: [(v) => v === null || Number.isInteger(v), 'Must be an integer'],
    },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true, toJSON },
);

categorySchema.index({ slug: 1 }, { unique: true });
categorySchema.index({ parentId: 1, sortOrder: 1 });

export const Category = mongoose.models.Category ?? mongoose.model('Category', categorySchema);
