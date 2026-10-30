import { z } from 'zod';
import { MAX_COMMISSION_BPS } from '../../config/constants.js';
import { objectId } from '../../lib/pagination.js';

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, digits and single hyphens')
  .max(80);

const shape = {
  name: z.string().trim().min(2).max(60),
  slug: slug.optional(), // derived from the name when omitted
  parentId: objectId('parent category id').nullable().optional(),
  defaultCommissionBps: z.number().int().min(0).max(MAX_COMMISSION_BPS).nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
};

export const createCategoryBody = z.strictObject(shape);
export const updateCategoryBody = z
  .strictObject(shape)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field');

export const categoryIdParams = z.object({ categoryId: objectId('category id') });
