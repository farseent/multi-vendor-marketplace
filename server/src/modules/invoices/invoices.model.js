import mongoose from 'mongoose';
import { toJSON } from '../../lib/modelJson.js';

const { ObjectId } = mongoose.Schema.Types;

// Only the number is stored. The PDF itself is generated on demand from the order (D19, D63).
const invoiceSchema = new mongoose.Schema(
  {
    orderId: { type: ObjectId, ref: 'Order', required: true },
    invoiceNumber: { type: String, required: true }, // INV-YYYY-NNNNNN
    generatedAt: { type: Date, required: true },
  },
  { timestamps: true, toJSON },
);

invoiceSchema.index({ orderId: 1 }, { unique: true }); // one invoice per order, whoever asks first
invoiceSchema.index({ invoiceNumber: 1 }, { unique: true });

export const Invoice = mongoose.models.Invoice ?? mongoose.model('Invoice', invoiceSchema);
