import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

const VALID = {
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://localhost:27017/marketplace',
  REDIS_URL: 'redis://localhost:6379',
  ELASTICSEARCH_URL: 'http://localhost:9200',
  CORS_ORIGINS: 'http://localhost:5173, https://shop.example.com',
};
const REQUIRED = Object.keys(VALID);
const serverRoot = fileURLToPath(new URL('..', import.meta.url));

describe('parseEnv', () => {
  it('parses valid config, applies defaults and splits CORS origins', () => {
    const env = parseEnv(VALID);
    expect(env.PORT).toBe(4000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'https://shop.example.com']);
  });

  it.each([
    ['MONGODB_URI', 'postgres://x'],
    ['REDIS_URL', 'http://localhost'],
    ['ELASTICSEARCH_URL', 'localhost:9200'],
    ['CORS_ORIGINS', 'http://localhost:5173/'],
    ['PORT', '70000'],
    ['NODE_ENV', 'staging'],
  ])('rejects invalid %s', (key, value) => {
    expect(() => parseEnv({ ...VALID, [key]: value })).toThrow(key);
  });

  it('does not echo values (they may contain credentials) in the error', () => {
    const secret = 'postgres://user:hunter2@host';
    expect(() => parseEnv({ ...VALID, MONGODB_URI: secret })).toThrow(/MONGODB_URI/);
    try {
      parseEnv({ ...VALID, MONGODB_URI: secret });
    } catch (err) {
      expect(err.message).not.toContain('hunter2');
    }
  });
});

// Acceptance: "App refuses to boot (exit != 0) if any required env var is missing/invalid"
describe('server boot', () => {
  const boot = (env) =>
    spawnSync(process.execPath, ['src/server.js'], {
      cwd: serverRoot,
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8',
      timeout: 15_000,
    });

  it('exits non-zero with no environment at all', () => {
    const result = boot({});
    expect(result.status).not.toBe(0);
    for (const key of REQUIRED) expect(result.stderr).toContain(key);
  });

  it.each(REQUIRED)('exits non-zero when %s is missing', (missing) => {
    const env = { ...VALID };
    delete env[missing];
    const result = boot(env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(missing);
  });

  it('exits non-zero when a variable is invalid', () => {
    const result = boot({ ...VALID, REDIS_URL: 'not-a-url' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('REDIS_URL');
  });
});