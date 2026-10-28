import { z } from 'zod';

const PHONE = /^\+?[1-9]\d{7,14}$/;
const phone = z.string().trim().regex(PHONE, 'Invalid phone number');
const text = (max) => z.string().trim().min(1).max(max);

// No .default() here on purpose: PATCH reuses this shape, and a default would silently
// overwrite fields the caller did not send (e.g. reset isDefault). Defaults live in the service.
const addressShape = {
  label: text(30),
  name: z.string().trim().min(2).max(80),
  phone,
  line1: text(120),
  line2: text(120).optional(),
  city: text(60),
  state: text(60),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Postal code must be 6 digits'),
  country: z.literal('IN').optional(),
  isDefault: z.boolean().optional(),
};

const atLeastOne = (obj) => Object.keys(obj).length > 0;

export const updateMeBody = z
  .strictObject({
    name: z.string().trim().min(2).max(80).optional(),
    phone: phone.nullable().optional(), // null clears the phone number
  })
  .refine(atLeastOne, 'Provide at least one field');

export const addressBody = z.strictObject(addressShape);
export const addressPatchBody = z
  .strictObject(addressShape)
  .partial()
  .refine(atLeastOne, 'Provide at least one field');

export const addressParams = z.object({
  addressId: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid address id'),
});
