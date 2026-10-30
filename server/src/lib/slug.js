import { randomBytes } from 'node:crypto';

/** "Handloom Cotton Kurta!" -> "handloom-cotton-kurta". Falls back when nothing usable is left. */
export function slugify(text, { fallback = 'item', maxLength = 50 } = {}) {
  const slug = String(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || fallback;
}

/** 4 random lowercase alphanumerics, used to make slugs unique ("kurta-x7k2"). */
export function shortId() {
  return Array.from(randomBytes(4), (b) => (b % 36).toString(36))
    .join('')
    .slice(0, 4);
}

/** True when a Mongo duplicate-key error is about the given field. */
export const isDuplicateOn = (err, field) => err?.code === 11000 && err.keyPattern?.[field] === 1;
