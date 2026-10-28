import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ZodError, z } from 'zod';
import { AppError } from '../src/lib/AppError.js';
import { buildTestApp, ORIGIN } from './helpers.js';

// Acceptance: "An unhandled thrown error returns the standard error envelope with a requestId
// and no stack trace when NODE_ENV=production."
function appThatThrows(error, nodeEnv) {
  return buildTestApp({
    nodeEnv,
    healthService: {
      liveness() {
        throw error;
      },
    },
  });
}

describe('error handling', () => {
  const bug = new Error('secret internal detail: db password is hunter2');

  it('production: unhandled error -> envelope with requestId, no stack, no leaked message', async () => {
    const res = await request(appThatThrows(bug, 'production')).get('/health');
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
    expect(res.body.error).not.toHaveProperty('stack');
    expect(res.text).not.toContain('hunter2');
    expect(res.text).not.toMatch(/\bat .*\.js:\d+/);
  });

  it('development: includes the stack to help debugging', async () => {
    const res = await request(appThatThrows(bug, 'development')).get('/health');
    expect(res.status).toBe(500);
    expect(res.body.error.stack).toContain('secret internal detail');
  });

  it('maps AppError to its status, code and details', async () => {
    const err = new AppError('OUT_OF_STOCK', 409, 'Not enough stock', [{ productId: 'p1' }]);
    const res = await request(appThatThrows(err, 'test')).get('/health');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'OUT_OF_STOCK',
      message: 'Not enough stock',
      details: [{ productId: 'p1' }],
    });
  });

  it('maps ZodError to 422 VALIDATION_ERROR with field paths', async () => {
    let zodError;
    try {
      z.object({ email: z.string().email() }).parse({ email: 'nope' });
    } catch (err) {
      zodError = err;
    }
    expect(zodError).toBeInstanceOf(ZodError);
    const res = await request(appThatThrows(zodError, 'test')).get('/health');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].path).toBe('email');
  });

  it('maps a Mongo duplicate-key error to 409 CONFLICT', async () => {
    const err = Object.assign(new Error('E11000 duplicate key'), {
      code: 11000,
      keyPattern: { email: 1 },
    });
    const res = await request(appThatThrows(err, 'test')).get('/health');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CONFLICT', details: [{ path: 'email' }] });
  });

  it('returns 404 NOT_FOUND envelope for unknown routes', async () => {
    const res = await request(buildTestApp()).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 BAD_REQUEST for malformed JSON bodies', async () => {
    const res = await request(buildTestApp())
      .post('/api/v1/anything')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects bodies over the 100 kB limit', async () => {
    const res = await request(buildTestApp())
      .post('/api/v1/anything')
      .send({ blob: 'x'.repeat(150_000) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
});

describe('request IDs', () => {
  it('generates one when absent and returns it in X-Request-Id', async () => {
    const res = await request(buildTestApp()).get('/health');
    expect(res.headers['x-request-id']).toMatch(/^req_[a-f0-9]{12}$/);
  });

  it('echoes a safe caller-supplied ID', async () => {
    const res = await request(buildTestApp())
      .get('/health')
      .set('X-Request-Id', 'client-req-12345');
    expect(res.headers['x-request-id']).toBe('client-req-12345');
  });

  it('replaces an unsafe caller-supplied ID', async () => {
    const res = await request(buildTestApp())
      .get('/health')
      .set('X-Request-Id', 'bad id\twith spaces');
    expect(res.headers['x-request-id']).toMatch(/^req_/);
  });
});

describe('security middleware', () => {
  it('sets helmet headers', async () => {
    const res = await request(buildTestApp()).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows the configured CORS origin with credentials', async () => {
    const res = await request(buildTestApp()).get('/health').set('Origin', ORIGIN);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not grant CORS to other origins', async () => {
    const res = await request(buildTestApp()).get('/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
