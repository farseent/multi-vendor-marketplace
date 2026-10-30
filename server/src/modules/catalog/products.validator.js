import { z } from 'zod';
import {
  MAX_PRODUCT_ATTRIBUTES,
  MAX_PRODUCT_IMAGES,
  MAX_STOCK_QTY,
  MIN_PRICE_PAISE,
} from '../../config/constants.js';
import { objectId, paginationQuery } from '../../lib/pagination.js';

// Prices and stock are whole numbers only: z.number().int() rejects 99.5 and "100" (strings).
const pricePaise = z.number().int().min(MIN_PRICE_PAISE, 'Price must be at least 100 paise');
const stockQty = z.number().int().min(0).max(MAX_STOCK_QTY);

const image = z.strictObject({
  key: z.string().trim().min(1).max(200),
  alt: z.string().trim().max(120).optional(),
});
const images = z.array(image).min(1).max(MAX_PRODUCT_IMAGES);

const attributes = z
  .record(z.string().trim().min(1).max(40), z.string().trim().max(100))
  .refine((obj) => Object.keys(obj).length <= MAX_PRODUCT_ATTRIBUTES, {
    message: `At most ${MAX_PRODUCT_ATTRIBUTES} attributes`,
  });

const productShape = {
  title: z.string().trim().min(3).max(150),
  description: z.string().trim().max(5000),
  categoryId: objectId('category id'),
  pricePaise,
  compareAtPricePaise: pricePaise,
  sku: z.string().trim().min(1).max(64),
  images,
  attributes,
};

export const createProductBody = z
  .strictObject({
    ...productShape,
    description: productShape.description.optional(),
    compareAtPricePaise: pricePaise.optional(),
    attributes: attributes.optional(),
    stockQty,
    status: z.enum(['draft', 'active']).default('draft'),
  })
  .refine((v) => v.compareAtPricePaise === undefined || v.compareAtPricePaise > v.pricePaise, {
    path: ['compareAtPricePaise'],
    message: 'Must be greater than the price',
  });

// Stock is not editable here on purpose: use PATCH .../stock (absolute set), so a form save
// cannot overwrite a newer stock number. null clears an optional field.
export const updateProductBody = z
  .strictObject({
    title: productShape.title.optional(),
    description: productShape.description.nullable().optional(),
    categoryId: productShape.categoryId.optional(),
    pricePaise: pricePaise.optional(),
    compareAtPricePaise: pricePaise.nullable().optional(),
    sku: productShape.sku.optional(),
    images: images.optional(),
    attributes: attributes.nullable().optional(),
    status: z.enum(['draft', 'active', 'archived']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field');

export const stockBody = z.strictObject({ stockQty });

export const productIdParams = z.object({ productId: objectId('product id') });
export const productSlugParams = z.object({
  slug: z
    .string()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid product slug')
    .max(100),
});

export const listProductsQuery = z.object({
  status: z.enum(['draft', 'active', 'archived', 'suspended']).optional(),
  sort: z.enum(['-createdAt', 'createdAt', '-updatedAt']).default('-createdAt'),
  ...paginationQuery,
});
