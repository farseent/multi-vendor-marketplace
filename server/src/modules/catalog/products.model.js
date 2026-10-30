import mongoose from 'mongoose';
import {
  MAX_PRODUCT_ATTRIBUTES,
  MAX_PRODUCT_IMAGES,
  MAX_STOCK_QTY,
  MIN_PRICE_PAISE,
  PRODUCT_STATUSES,
} from '../../config/constants.js';

const toJSON = {
  virtuals: true,
  versionKey: false,
  flattenMaps: true, // attributes come out as a plain object
  transform(_doc, ret) {
    delete ret._id;
    return ret;
  },
};

const isInt = { validator: Number.isInteger, message: 'Must be a whole number' };

const imageSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    alt: { type: String, trim: true, maxlength: 120 },
  },
  { _id: false, id: false },
);

const productSchema = new mongoose.Schema(
  {
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    title: { type: String, required: true, trim: true, minlength: 3, maxlength: 150 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    description: { type: String, trim: true, maxlength: 5000 },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
    // Money is always integer paise (D5); the API never accepts rupee floats.
    pricePaise: { type: Number, required: true, min: MIN_PRICE_PAISE, validate: isInt },
    compareAtPricePaise: {
      type: Number,
      validate: [
        isInt,
        {
          validator(value) {
            return value == null || value > this.pricePaise;
          },
          message: 'compareAtPricePaise must be greater than pricePaise',
        },
      ],
    },
    sku: { type: String, required: true, trim: true, maxlength: 64 },
    stockQty: { type: Number, required: true, min: 0, max: MAX_STOCK_QTY, validate: isInt },
    images: {
      type: [imageSchema],
      validate: [
        (list) => list.length >= 1 && list.length <= MAX_PRODUCT_IMAGES,
        `Between 1 and ${MAX_PRODUCT_IMAGES} images are required`,
      ],
    },
    attributes: {
      type: Map,
      of: String,
      validate: [(map) => !map || map.size <= MAX_PRODUCT_ATTRIBUTES, 'Too many attributes'],
    },
    status: { type: String, enum: PRODUCT_STATUSES, default: 'draft' },
    ratingAvg: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0, validate: isInt },
    soldCount: { type: Number, default: 0, min: 0, validate: isInt },
  },
  { timestamps: true, toJSON },
);

productSchema.index({ slug: 1 }, { unique: true });
productSchema.index({ vendorId: 1, sku: 1 }, { unique: true });
productSchema.index({ vendorId: 1, status: 1, createdAt: -1 });
productSchema.index({ categoryId: 1, status: 1, pricePaise: 1 });
productSchema.index({ title: 'text', description: 'text' }); // Mongo search fallback (Phase 3)

export const Product = mongoose.models.Product ?? mongoose.model('Product', productSchema);
