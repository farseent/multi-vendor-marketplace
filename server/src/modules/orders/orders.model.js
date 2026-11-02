import mongoose from 'mongoose';
import {
  FULFILLMENT_STATUSES,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  REFUND_STATUSES,
} from '../../config/constants.js';
import { paise, toJSON } from '../../lib/modelJson.js';

const { ObjectId } = mongoose.Schema.Types;

// A copy of the customer's address at checkout time: later edits must not change an old order.
const addressSnapshot = new mongoose.Schema(
  {
    label: String,
    name: String,
    phone: String,
    line1: String,
    line2: String,
    city: String,
    state: String,
    postalCode: String,
    country: String,
  },
  { _id: false },
);

const couponSnapshot = new mongoose.Schema(
  {
    couponId: { type: ObjectId, required: true },
    code: { type: String, required: true },
    fundedBy: { type: String, enum: ['vendor', 'platform'], required: true },
    discountPaise: paise,
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true }, // MP-YYYYMMDD-NNNNNN
    customerId: { type: ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ORDER_STATUSES, default: 'pending_payment' },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: 'unpaid' },
    refundStatus: { type: String, enum: REFUND_STATUSES, default: 'none' },
    currency: { type: String, enum: ['INR'], default: 'INR' },
    shippingAddress: { type: addressSnapshot, required: true },
    subtotalPaise: paise,
    discountPaise: paise,
    shippingPaise: paise,
    totalPaise: paise, // subtotal - discount + shipping
    coupon: { type: couponSnapshot, default: null },
    reservationExpiresAt: Date, // set while pending_payment
    idempotencyKey: { type: String, required: true },
    paymentId: { type: ObjectId, ref: 'Payment' },
    placedAt: Date, // set by markOrderPaid
  },
  { timestamps: true, toJSON },
);

orderSchema.index({ orderNumber: 1 }, { unique: true });
orderSchema.index({ customerId: 1, createdAt: -1 });
orderSchema.index({ customerId: 1, idempotencyKey: 1 }, { unique: true });
orderSchema.index(
  { status: 1, reservationExpiresAt: 1 },
  { partialFilterExpression: { status: 'pending_payment' } },
);
orderSchema.index({ createdAt: -1 });

const itemSchema = new mongoose.Schema(
  {
    productId: { type: ObjectId, required: true },
    title: { type: String, required: true },
    sku: { type: String, required: true },
    imageKey: String,
    unitPricePaise: paise,
    quantity: { type: Number, required: true, min: 1, validate: Number.isInteger },
    lineSubtotalPaise: paise,
    discountPaise: paise,
    lineNetPaise: paise,
  },
  { _id: false },
);

const commissionSchema = new mongoose.Schema(
  {
    rateBps: { type: Number, required: true, min: 0, max: 5000, validate: Number.isInteger },
    rateSource: { type: String, enum: ['vendor', 'category', 'platform'], required: true },
    amountPaise: paise,
    basePaise: paise,
  },
  { _id: false },
);

const historySchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    at: { type: Date, required: true },
    byUserId: ObjectId, // absent when the system made the change (expiry, payment confirmation)
    note: String,
  },
  { _id: false },
);

const subOrderSchema = new mongoose.Schema(
  {
    subOrderNumber: { type: String, required: true }, // {orderNumber}-V{n}
    orderId: { type: ObjectId, ref: 'Order', required: true },
    customerId: { type: ObjectId, ref: 'User', required: true },
    vendorId: { type: ObjectId, ref: 'Vendor', required: true },
    items: { type: [itemSchema], validate: [(list) => list.length > 0, 'At least one item'] },
    subtotalPaise: paise,
    discountPaise: paise,
    shippingPaise: paise,
    customerTotalPaise: paise,
    commission: { type: commissionSchema, required: true },
    vendorPayoutPaise: paise,
    fulfillmentStatus: { type: String, enum: FULFILLMENT_STATUSES, default: 'pending_payment' },
    refundStatus: {
      type: String,
      enum: ['none', 'pending', 'partial', 'full', 'failed'],
      default: 'none',
    },
    refundedPaise: { type: Number, default: 0, min: 0, validate: Number.isInteger },
    stockRestored: { type: Boolean, default: false }, // guard against restocking twice
    tracking: { carrier: String, trackingNumber: String },
    statusHistory: { type: [historySchema], default: [] }, // append-only
    deliveredAt: Date,
    returnWindowEndsAt: Date,
  },
  // Explicit: Mongoose would pluralise to `suborders`, but collections are plural camelCase
  // (PROJECT_MASTER 6).
  { timestamps: true, toJSON, collection: 'subOrders' },
);

subOrderSchema.index({ orderId: 1 });
subOrderSchema.index({ vendorId: 1, fulfillmentStatus: 1, createdAt: -1 });
subOrderSchema.index({ customerId: 1, createdAt: -1 });
subOrderSchema.index({ subOrderNumber: 1 }, { unique: true });
subOrderSchema.index(
  { returnWindowEndsAt: 1 },
  { partialFilterExpression: { fulfillmentStatus: 'delivered' } },
);

// `counters`: { _id: 'orderNumber:YYYYMMDD', seq } (DATABASE_SCHEMA, supporting collections).
const counterSchema = new mongoose.Schema(
  { _id: { type: String, required: true }, seq: { type: Number, required: true } },
  { collection: 'counters', versionKey: false },
);

export const Order = mongoose.models.Order ?? mongoose.model('Order', orderSchema);
export const SubOrder = mongoose.models.SubOrder ?? mongoose.model('SubOrder', subOrderSchema);
export const Counter = mongoose.models.Counter ?? mongoose.model('Counter', counterSchema);
