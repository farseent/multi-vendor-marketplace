import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp, listApiRoutes, TEST_AUTH_CONFIG } from './helpers.js';

// No database needed: these requests are accepted or rejected by middleware before any query.
const app = buildTestApp();
const token = (role) =>
  jwt.sign({ role }, TEST_AUTH_CONFIG.jwtSecret, { subject: '0'.repeat(24), expiresIn: 600 });
const bearer = (role) => ({ Authorization: `Bearer ${token(role)}` });

const sample = (path) => path.replace(/:\w+/g, '0'.repeat(24));
const call = (route, headers = {}) =>
  request(app)[route.method.toLowerCase()](sample(route.path)).set(headers).send({});

const routes = listApiRoutes(app);

describe('route table', () => {
  it('enumerates the registered Phase 1 and 2 routes (guards the guard tests below)', () => {
    const keys = routes.map((r) => `${r.method} ${r.path}`);
    expect(keys).toEqual(
      expect.arrayContaining([
        'POST /api/v1/auth/login',
        'POST /api/v1/auth/refresh',
        'GET /api/v1/auth/me',
        'GET /api/v1/users/me',
        'DELETE /api/v1/users/me/addresses/:addressId',
        // Phase 2
        'GET /api/v1/vendor/profile',
        'POST /api/v1/vendor/products',
        'PATCH /api/v1/vendor/products/:productId/stock',
        'POST /api/v1/vendor/uploads/presign',
        'PATCH /api/v1/admin/vendors/:vendorId/status',
        'POST /api/v1/admin/categories',
        'GET /api/v1/products/:slug',
      ]),
    );
  });

  it('has real /vendor/* and /admin/* routes, so the role checks below are not vacuous', () => {
    const gated = routes.filter((r) => /^\/api\/v1\/(vendor|admin)(\/|$)/.test(r.path));
    expect(gated.length).toBeGreaterThanOrEqual(15);
    expect(gated.some((r) => r.path.startsWith('/api/v1/vendor/'))).toBe(true);
    expect(gated.some((r) => r.path.startsWith('/api/v1/admin/'))).toBe(true);
  });
});

// Routes that must answer without an access token (auth bootstrap + cookie-based routes).
const ANONYMOUS_OK = new Set([
  'POST /api/v1/auth/register',
  'POST /api/v1/auth/register-vendor',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/logout',
  // Phase 2 public catalog pages
  'GET /api/v1/categories',
  'GET /api/v1/products/:slug',
  'GET /api/v1/shops/:shopSlug',
]);

describe('authorization matrix (every registered route)', () => {
  const protectedRoutes = routes.filter((r) => !ANONYMOUS_OK.has(`${r.method} ${r.path}`));

  it.each(protectedRoutes.map((r) => [`${r.method} ${r.path}`, r]))(
    '%s -> 401 without a token',
    async (_name, route) => {
      const res = await call(route);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    },
  );

  // Acceptance: "A customer token calling any /vendor/* or /admin/* route returns 403"
  it('customer token on every registered /vendor/* and /admin/* route -> 403', async () => {
    const gated = routes.filter((r) => /^\/api\/v1\/(vendor|admin)(\/|$)/.test(r.path));
    for (const route of gated) {
      const res = await call(route, bearer('customer'));
      expect(res.status, `${route.method} ${route.path}`).toBe(403);
    }
  });

  it('a vendor token on every /admin/* route and an admin token on every /vendor/* route -> 403', async () => {
    const admin = routes.filter((r) => r.path.startsWith('/api/v1/admin/'));
    const vendor = routes.filter((r) => r.path.startsWith('/api/v1/vendor/'));
    for (const route of admin) {
      expect((await call(route, bearer('vendor'))).status, `${route.method} ${route.path}`).toBe(
        403,
      );
    }
    for (const route of vendor) {
      expect((await call(route, bearer('admin'))).status, `${route.method} ${route.path}`).toBe(
        403,
      );
    }
  });

  it('public catalog routes need no token (they must not answer 401/403)', async () => {
    // Malformed params are rejected by validation (422) before any database access.
    for (const path of ['/api/v1/products/Bad_Slug!', '/api/v1/shops/Bad_Slug!']) {
      expect((await request(app).get(path)).status).toBe(422);
    }
  });
});

describe('structural role guard on /vendor and /admin', () => {
  // These paths have no handlers. The guard must still answer, so a route added later cannot
  // be reached by the wrong role even if its author forgets authorize().
  const hit = (path, headers) =>
    request(app)
      .get(path)
      .set(headers ?? {});

  it.each([
    ['/api/v1/vendor/anything', undefined, 401],
    ['/api/v1/admin/anything', undefined, 401],
    ['/api/v1/vendor/anything', bearer('customer'), 403],
    ['/api/v1/admin/anything', bearer('customer'), 403],
    ['/api/v1/admin/anything', bearer('vendor'), 403],
    ['/api/v1/vendor/anything', bearer('admin'), 403],
    ['/API/V1/VENDOR/anything', bearer('customer'), 403], // Express routing is case-insensitive
  ])('GET %s -> %s', async (path, headers, status) => {
    expect((await hit(path, headers)).status).toBe(status);
  });

  it('lets the right role through to routing (404 here only because these paths have no handler)', async () => {
    expect((await hit('/api/v1/vendor/anything', bearer('vendor'))).status).toBe(404);
    expect((await hit('/api/v1/admin/anything', bearer('admin'))).status).toBe(404);
  });
});

describe('authenticate/authorize with a forged role', () => {
  it('a token signed with the wrong secret claiming role=admin is rejected', async () => {
    const forged = jwt.sign({ role: 'admin' }, 'x'.repeat(40), { subject: '1' });
    const res = await request(app)
      .get('/api/v1/admin/anything')
      .set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });
});
