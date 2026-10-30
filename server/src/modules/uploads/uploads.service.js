import { randomUUID } from 'node:crypto';
import { UPLOAD } from '../../config/constants.js';
import { AppError } from '../../lib/AppError.js';
import { keyFor } from '../../lib/uploadKeys.js';

/** Hands out short-lived presigned PUT URLs so image bytes never pass through the API. */
export function createUploadsService({ storage = null }) {
  return {
    async presign(vendorId, { contentType, sizeBytes }) {
      if (!storage) {
        throw new AppError('SERVICE_UNAVAILABLE', 503, 'Image uploads are not configured');
      }
      // The key is built here, from the shop record: the client cannot choose its own path.
      const key = keyFor(vendorId, randomUUID(), UPLOAD.types[contentType]);
      const uploadUrl = await storage.presignPut({
        key,
        contentType,
        sizeBytes,
        expiresIn: UPLOAD.urlTtlSeconds,
      });
      return {
        uploadUrl,
        method: 'PUT',
        // The browser must send exactly these headers or S3 rejects the signature.
        headers: { 'Content-Type': contentType },
        key,
        publicUrl: storage.publicUrl(key),
        expiresInSeconds: UPLOAD.urlTtlSeconds,
      };
    },
  };
}
