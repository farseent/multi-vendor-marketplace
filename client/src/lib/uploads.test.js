import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES, validateImageFile } from './uploads.js';

describe('validateImageFile', () => {
  it('accepts jpeg, png and webp up to 5 MB', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      expect(validateImageFile({ type, size: 1000 })).toBeNull();
    }
    expect(validateImageFile({ type: 'image/png', size: MAX_IMAGE_BYTES })).toBeNull();
  });

  it('rejects other types, empty files and files over 5 MB', () => {
    expect(validateImageFile({ type: 'image/gif', size: 1000 })).toMatch(/JPEG, PNG or WebP/);
    expect(validateImageFile({ type: 'image/svg+xml', size: 1000 })).toMatch(/JPEG, PNG or WebP/);
    expect(validateImageFile({ type: '', size: 1000 })).toMatch(/JPEG, PNG or WebP/);
    expect(validateImageFile({ type: 'image/png', size: 0 })).toMatch(/empty/);
    expect(validateImageFile({ type: 'image/png', size: MAX_IMAGE_BYTES + 1 })).toMatch(/5 MB/);
  });
});
