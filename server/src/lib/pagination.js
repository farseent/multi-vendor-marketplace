import { z } from 'zod';

/** ?page=1&limit=20 (max 100), the project-wide pagination shape (PROJECT_MASTER section 6). */
export const paginationQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

export const skipFor = ({ page, limit }) => (page - 1) * limit;

export const pageMeta = ({ page, limit }, total) => ({
  page,
  limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / limit)),
});

/** Zod fragment for a 24-hex ObjectId route param. */
export const objectId = (label) => z.string().regex(/^[a-f0-9]{24}$/i, `Invalid ${label}`);
