import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers.js';

const down = async () => {
  throw new Error('connect ECONNREFUSED 10.0.0.5:6379');
};

describe('GET /health (liveness)', () => {
  it('returns 200 and does not touch dependencies', async () => {
    const app = buildTestApp({ checks: { mongo: down } });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
  });
});

describe('GET /health/ready', () => {
  it('returns 200 / ok with component statuses when everything is up', async () => {
    const res = await request(buildTestApp()).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
    expect(Object.keys(res.body.data.components)).toEqual(['mongo', 'redis', 'elasticsearch']);
    expect(res.body.data.components.mongo.status).toBe('up');
  });

  it('is also served under /api/v1/health', async () => {
    const res = await request(buildTestApp()).get('/api/v1/health/ready');
    expect(res.status).toBe(200);
  });

  it('reports Redis or Elasticsearch down as degraded, not fatal', async () => {
    const app = buildTestApp({ checks: { redis: down } });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('degraded');
    expect(res.body.data.components.redis.status).toBe('down');
    expect(res.body.data.components.mongo.status).toBe('up');
  });

  it('returns 503 SERVICE_UNAVAILABLE when Mongo is down', async () => {
    const app = buildTestApp({ checks: { mongo: down } });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.requestId).toBeTruthy();
    expect(res.body.error.details.components.mongo.status).toBe('down');
  });

  it('treats a hanging dependency as down (timeout)', async () => {
    const hang = () => new Promise(() => {});
    const res = await request(buildTestApp({ checks: { elasticsearch: hang } })).get(
      '/health/ready',
    );
    expect(res.status).toBe(200);
    expect(res.body.data.components.elasticsearch.status).toBe('down');
  });

  it('never leaks connection error text (hostnames, ports) in the response', async () => {
    const res = await request(buildTestApp({ checks: { redis: down } })).get('/health/ready');
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
  });
});
