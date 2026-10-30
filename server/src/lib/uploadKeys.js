import { UPLOAD, UPLOAD_KEY_PREFIX } from '../config/constants.js';

const EXTENSIONS = [...new Set(Object.values(UPLOAD.types))].join('|');

/** products/{vendorId}/{random}.{jpg|png|webp}: the only key shape presign ever hands out. */
export const ownedKeyPattern = (vendorId) =>
  new RegExp(`^${UPLOAD_KEY_PREFIX}/${String(vendorId)}/[A-Za-z0-9_-]{1,64}\\.(${EXTENSIONS})$`);

/** A key is acceptable only inside the caller's own prefix (blocks pointing at another vendor's files). */
export const isOwnedKey = (key, vendorId) => ownedKeyPattern(vendorId).test(key);

export const keyFor = (vendorId, id, ext) => `${UPLOAD_KEY_PREFIX}/${vendorId}/${id}.${ext}`;
