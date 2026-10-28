import mongoose from 'mongoose';
import { MAX_ADDRESSES } from '../../config/constants.js';

const PHONE = /^\+?[1-9]\d{7,14}$/; // E.164-ish
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// API returns `id`, never `_id`, `__v` or `passwordHash` (DATABASE_SCHEMA conventions).
const toJSON = {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret) {
    delete ret._id;
    delete ret.passwordHash;
    return ret;
  },
};

const addressSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 30 },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
    phone: { type: String, required: true, trim: true, match: PHONE },
    line1: { type: String, required: true, trim: true, maxlength: 120 },
    line2: { type: String, trim: true, maxlength: 120 },
    city: { type: String, required: true, trim: true, maxlength: 60 },
    state: { type: String, required: true, trim: true, maxlength: 60 },
    postalCode: { type: String, required: true, trim: true, match: /^\d{6}$/ },
    country: { type: String, enum: ['IN'], default: 'IN' },
    isDefault: { type: Boolean, default: false },
  },
  { toJSON },
);

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, match: EMAIL },
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
    phone: { type: String, trim: true, match: PHONE },
    role: { type: String, enum: ['customer', 'vendor', 'admin'], default: 'customer' },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    addresses: {
      type: [addressSchema],
      validate: [(list) => list.length <= MAX_ADDRESSES, `At most ${MAX_ADDRESSES} addresses`],
    },
    lastLoginAt: Date,
  },
  { timestamps: true, toJSON },
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ role: 1, status: 1 });

export const User = mongoose.models.User ?? mongoose.model('User', userSchema);
