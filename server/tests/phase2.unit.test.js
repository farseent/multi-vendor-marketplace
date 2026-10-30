import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';
import { isOwnedKey, keyFor } from '../src/lib/uploadKeys.js';
import { isDuplicateOn, shortId, slugify } from '../src/lib/slug.js';

const BASE_ENV = {
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://localhost:27017/x',
  REDIS_URL: 'redis://localhost:6379',
  ELASTICSEARCH_URL: 'http://localhost:9200',
  CORS_ORIGINS: 'http://localhost:5173',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
};

describe('slugify / shortId', () => {
  it.each([
    ['Handloom Cotton Kurta', 'handloom-cotton-kurta'],
    ['  Loom & Co!!  ', 'loom-co'],
    ['Café Déco', 'cafe-deco'],
    ['---a---b---', 'a-b'],
  ])('%s -> %s', (input, expected) => expect(slugify(input)).toBe(expected));

  it('falls back when nothing usable is left and caps the length', () => {
    expect(slugify('!!!', { fallback: 'shop' })).toBe('shop');
    expect(slugify('കേരളം', { fallback: 'shop' })).toBe('shop');
    expect(slugify('a'.repeat(200), { maxLength: 60 })).toHaveLength(60);
  });

  it('shortId is 4 lowercase alphanumerics', () => {
    for (let i = 0; i < 50; i++) expect(shortId()).toMatch(/^[a-z0-9]{4}$/);
  });

  it('isDuplicateOn matches only the named index', () => {
    const err = { code: 11000, keyPattern: { shopSlug: 1 } };
    expect(isDuplicateOn(err, 'shopSlug')).toBe(true);
    expect(isDuplicateOn(err, 'userId')).toBe(false);
    expect(isDuplicateOn(new Error('x'), 'shopSlug')).toBe(false);
  });
});

describe('isOwnedKey', () => {
  const vendorId = 'a'.repeat(24);
  const other = 'b'.repeat(24);
  it('accepts keys built by keyFor and short test-style names', () => {
    expect(
      isOwnedKey(keyFor(vendorId, 'f47ac10b-58cc-4372-a567-0e02b2c3d479', 'webp'), vendorId),
    ).toBe(true);
    expect(isOwnedKey(`products/${vendorId}/9f2a.png`, vendorId)).toBe(true);
  });
  it.each([
    `products/${other}/9f2a.png`,
    `products/${vendorId}/../${other}/x.png`,
    `products/${vendorId}/a/b.png`,
    `products/${vendorId}/x.exe`,
    `products/${vendorId}/x.png/`,
    `other/${vendorId}/x.png`,
    `products/${vendorId}/`,
    '',
  ])('rejects %s', (key) => expect(isOwnedKey(key, vendorId)).toBe(false));
});

describe('env: S3 settings', () => {
  it('boots without any S3 variable (uploads are simply disabled)', () => {
    const env = parseEnv(BASE_ENV);
    expect(env.S3_BUCKET).toBeUndefined();
  });

  it('treats empty values from .env as not set', () => {
    const env = parseEnv({ ...BASE_ENV, S3_BUCKET: '', S3_REGION: '', S3_PUBLIC_BASE_URL: '' });
    expect(env.S3_BUCKET).toBeUndefined();
    expect(env.S3_PUBLIC_BASE_URL).toBeUndefined();
  });

  it('requires a region when a bucket is set', () => {
    expect(() => parseEnv({ ...BASE_ENV, S3_BUCKET: 'my-bucket' })).toThrow(/S3_REGION/);
    expect(
      parseEnv({ ...BASE_ENV, S3_BUCKET: 'my-bucket', S3_REGION: 'ap-south-1' }).S3_BUCKET,
    ).toBe('my-bucket');
  });

  it('validates the public base URL', () => {
    expect(() =>
      parseEnv({ ...BASE_ENV, S3_BUCKET: 'b', S3_REGION: 'r', S3_PUBLIC_BASE_URL: 'not a url' }),
    ).toThrow(/S3_PUBLIC_BASE_URL/);
    const ok = parseEnv({
      ...BASE_ENV,
      S3_BUCKET: 'b',
      S3_REGION: 'r',
      S3_PUBLIC_BASE_URL: 'https://cdn.example.com',
    });
    expect(ok.S3_PUBLIC_BASE_URL).toBe('https://cdn.example.com');
  });
});
