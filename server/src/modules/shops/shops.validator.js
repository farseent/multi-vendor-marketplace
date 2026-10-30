import { z } from 'zod';
import { MAX_COMMISSION_BPS } from '../../config/constants.js';
import { objectId, paginationQuery } from '../../lib/pagination.js';

const shopName = z.string().trim().min(3, 'Shop name must be 3-60 characters').max(60);
const description = z.string().trim().max(1000);

export const createShopBody = z.strictObject({
  shopName,
  description: description.optional(),
});

// logoKey can only be set after the shop exists: its prefix contains the vendor id.
// null clears the logo / description.
export const updateShopBody = z
  .strictObject({
    shopName: shopName.optional(),
    description: description.nullable().optional(),
    logoKey: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field');

export const shopSlugParams = z.object({
  shopSlug: z
    .string()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid shop slug')
    .max(80),
});

export const vendorIdParams = z.object({ vendorId: objectId('vendor id') });

export const listVendorsQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'suspended']).optional(),
  ...paginationQuery,
});

// "pending" is never a target: a shop only starts there.
export const vendorStatusBody = z.strictObject({
  status: z.enum(['approved', 'rejected', 'suspended']),
});

// null removes the override, so the category/platform default applies again.
export const commissionBody = z.strictObject({
  commissionRateBps: z.number().int().min(0).max(MAX_COMMISSION_BPS).nullable(),
});
