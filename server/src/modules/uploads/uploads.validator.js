import { z } from 'zod';
import { UPLOAD } from '../../config/constants.js';

// The browser declares what it is about to upload; S3 then enforces exactly this type and size
// because both are part of the presigned signature.
export const presignBody = z.strictObject({
  contentType: z.enum(Object.keys(UPLOAD.types), {
    error: 'Only JPEG, PNG or WebP images are allowed',
  }),
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(UPLOAD.maxBytes, `Image must be at most ${UPLOAD.maxBytes / (1024 * 1024)} MB`),
});
