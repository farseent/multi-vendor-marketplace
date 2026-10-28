import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/lib/password.js';
import { parseEnv } from '../src/config/env.js';

describe('password hashing', () => {
  // Acceptance: "Passwords stored as bcrypt hashes (cost >= 12)"
  it('produces a bcrypt hash with cost 12 and verifies it', async () => {
    const hash = await hashPassword('S3cure!pass99', 12);
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(await verifyPassword('S3cure!pass99', hash)).toBe(true);
    expect(await verifyPassword('wrong-pass-1', hash)).toBe(false);
  });

  it('env cannot lower the cost below 12', () => {
    const base = {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://localhost/x',
      REDIS_URL: 'redis://localhost',
      ELASTICSEARCH_URL: 'http://localhost:9200',
      CORS_ORIGINS: 'http://localhost:5173',
      JWT_ACCESS_SECRET: 'x'.repeat(32),
    };
    expect(parseEnv(base).BCRYPT_COST).toBe(12);
    expect(() => parseEnv({ ...base, BCRYPT_COST: '8' })).toThrow('BCRYPT_COST');
  });
});
