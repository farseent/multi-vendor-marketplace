import { apiFetch } from './api.js';

// Mirrors the server rules (UPLOAD in server constants). The server is the real gatekeeper:
// these checks only give instant feedback before a pointless round trip.
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Returns an error message, or null when the file looks acceptable. */
export function validateImageFile(file) {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) return 'Use a JPEG, PNG or WebP image.';
  if (file.size < 1) return 'That file is empty.';
  if (file.size > MAX_IMAGE_BYTES) return 'Images can be at most 5 MB.';
  return null;
}

/**
 * Two steps (ARCHITECTURE 3.7): ask the API for a presigned URL, then PUT the file straight to S3.
 * The PUT is a plain fetch on purpose: no cookies and no Authorization header go to S3.
 * Resolves to { key, url }; the key is what gets saved on the product.
 */
export async function uploadImage(file) {
  const problem = validateImageFile(file);
  if (problem) throw new Error(problem);

  const { data } = await apiFetch('/vendor/uploads/presign', {
    method: 'POST',
    body: { contentType: file.type, sizeBytes: file.size },
  });

  let res;
  try {
    res = await fetch(data.uploadUrl, { method: data.method, headers: data.headers, body: file });
  } catch {
    throw new Error('Upload failed: could not reach the image storage.');
  }
  if (!res.ok) throw new Error(`Upload failed (storage answered ${res.status}).`);
  return { key: data.key, url: data.publicUrl };
}
