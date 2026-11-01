import { z } from 'zod';
import { COUPON } from '../../config/constants.js';
import { objectId, paginationQuery } from '../../lib/pagination.js';

const paise = z.number().int().min(0);
const positiveInt = z.number().int().min(1);
// ISO-8601 with a timezone ("2026-11-01T00:00:00Z"); parsed to a Date for the service.
const dateTime = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_-]{4,20}$/, 'Use 4-20 letters, digits, "-" or "_"');

// Same body for vendor and admin: scope, fundedBy and vendorId are decided by the route (the
// vendor id comes from the authenticated shop), never by the request.
export const createCouponBody = z.strictObject({
  code,
  type: z.enum(COUPON.types),
  value: positiveInt,
  minOrderPaise: paise.default(0),
  maxDiscountPaise: positiveInt.optional(),
  startsAt: dateTime,
  expiresAt: dateTime,
  usageLimitTotal: positiveInt.optional(),
  usageLimitPerUser: positiveInt.default(1),
  status: z.enum(COUPON.statuses).default('active'),
});

// code, scope and type are fixed once a coupon exists. null clears an optional limit.
export const updateCouponBody = z
  .strictObject({
    value: positiveInt.optional(),
    minOrderPaise: paise.optional(),
    maxDiscountPaise: positiveInt.nullable().optional(),
    startsAt: dateTime.optional(),
    expiresAt: dateTime.optional(),
    usageLimitTotal: positiveInt.nullable().optional(),
    usageLimitPerUser: positiveInt.optional(),
    status: z.enum(COUPON.statuses).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field');

export const couponIdParams = z.object({ couponId: objectId('coupon id') });

export const listCouponsQuery = z.object({
  status: z.enum(COUPON.statuses).optional(),
  ...paginationQuery,
});
