import mongoose from 'mongoose';
import { CART } from '../../config/constants.js';

const toJSON = {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret) {
    delete ret._id;
    return ret;
  },
};

const itemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      max: CART.maxQuantity,
      validate: { validator: Number.isInteger, message: 'Must be a whole number' },
    },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

// No prices are stored (DATABASE_SCHEMA): the preview always reads current prices from Mongo.
const cartSchema = new mongoose.Schema(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    items: {
      type: [itemSchema],
      validate: [(list) => list.length <= CART.maxItems, `At most ${CART.maxItems} items`],
    },
    couponCode: { type: String, uppercase: true, trim: true },
  },
  { timestamps: true, toJSON },
);

cartSchema.index({ customerId: 1 }, { unique: true });

export const Cart = mongoose.models.Cart ?? mongoose.model('Cart', cartSchema);
