import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { RefreshToken } from '../src/modules/auth/auth.model.js';
import { hashToken } from '../src/modules/auth/auth.tokens.js';
import { User } from '../src/modules/users/users.model.js';
import { clearDb, startTestDb, stopTestDb } from './db.js';
import { buildTestApp, ORIGIN, TEST_AUTH_CONFIG } from './helpers.js';

const CREDS = { name: 'Asha K', email: 'asha@example.com', password: 'S3cure!pass99' };
let replSet;
let app;

beforeAll(async () => {
  replSet = await startTestDb();
}, 60_000);
afterAll(() => stopTestDb(replSet));
beforeEach(async () => {
  await clearDb();
  app = buildTestApp(); // fresh app = fresh in-memory rate-limit counters
});

const cookieValue = (res) => {
  const header = (res.headers['set-cookie'] ?? []).find((c) => c.startsWith('refreshToken='));
  return header?.split(';')[0].split('=')[1];
};
const register = (body = CREDS) => request(app).post('/api/v1/auth/register').send(body);
const LOGIN = { email: CREDS.email, password: CREDS.password };
const login = (body = LOGIN) => request(app).post('/api/v1/auth/login').send(body);
const refresh = (token) =>
  request(app).post('/api/v1/auth/refresh').set('Cookie', `refreshToken=${token}`);
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

describe('POST /auth/register', () => {
  it('creates a customer, returns user + access token, sets a hardened refresh cookie', async () => {
    const res = await register();
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toMatchObject({
      email: CREDS.email,
      name: 'Asha K',
      role: 'customer',
    });
    expect(res.body.data.user.id).toMatch(/^[a-f0-9]{24}$/);
    expect(res.body.data.accessToken).toEqual(expect.any(String));

    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('refreshToken='));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  // Acceptance: "no endpoint ever returns passwordHash"
  it('never returns passwordHash, and stores a bcrypt hash', async () => {
    const res = await register();
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
    const stored = await User.findOne({ email: CREDS.email }).select('+passwordHash');
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$04\$/); // cost 4 in tests only
    expect(stored.passwordHash).not.toContain(CREDS.password);
  });

  it('puts the documented claims on the access token with a 15 minute lifetime', async () => {
    const { body } = await register();
    const claims = jwt.verify(body.data.accessToken, TEST_AUTH_CONFIG.jwtSecret);
    expect(claims).toMatchObject({ sub: body.data.user.id, role: 'customer' });
    expect(claims.exp - claims.iat).toBe(900);
  });

  it('normalizes the email (trim + lowercase)', async () => {
    const res = await register({ ...CREDS, email: '  Asha@Example.COM ' });
    expect(res.body.data.user.email).toBe('asha@example.com');
  });

  // Acceptance: "Duplicate email returns 409"
  it('returns 409 for a duplicate email, case-insensitively', async () => {
    await register();
    const res = await register({ ...CREDS, email: 'ASHA@example.com' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  // Acceptance: "weak password returns 422 with field details"
  it.each([
    ['too short', 'Ab1'],
    ['no digit', 'OnlyLettersHere'],
    ['no letter', '1234567890123'],
    ['over 72 characters', `a1${'x'.repeat(71)}`],
    ['over 72 bytes (multi-byte)', `a1${'é'.repeat(36)}`],
  ])('rejects a weak password: %s', async (_label, password) => {
    const res = await register({ ...CREDS, password });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].path).toBe('body.password');
  });

  it('rejects unknown fields, including a role escalation attempt', async () => {
    const res = await register({ ...CREDS, role: 'admin' });
    expect(res.status).toBe(422);
    expect(await User.countDocuments()).toBe(0);
  });

  it('rejects a bad email and a missing name with field paths', async () => {
    const res = await register({ email: 'nope', password: CREDS.password });
    expect(res.status).toBe(422);
    const paths = res.body.error.details.map((d) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['body.email', 'body.name']));
  });
});

describe('POST /auth/register-vendor', () => {
  it('creates a user with role vendor', async () => {
    const res = await request(app).post('/api/v1/auth/register-vendor').send(CREDS);
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('vendor');
  });

  it('shares the register rate limit (5/hour/IP) with /auth/register', async () => {
    for (let i = 0; i < 5; i++) {
      const path = i % 2 ? 'register' : 'register-vendor';
      const res = await request(app)
        .post(`/api/v1/auth/${path}`)
        .send({ ...CREDS, email: `u${i}@example.com` });
      expect(res.status).toBe(201);
    }
    const res = await register({ ...CREDS, email: 'u6@example.com' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('POST /auth/login', () => {
  beforeEach(() => register());

  it('logs in and returns the same shape as register', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(CREDS.email);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(cookieValue(res)).toBeTruthy();
    expect((await User.findOne({ email: CREDS.email })).lastLoginAt).toBeInstanceOf(Date);
  });

  it('gives the same generic 401 for a wrong password and an unknown email', async () => {
    const wrong = await login({ ...LOGIN, password: 'Wrong!pass99' });
    const unknown = await login({ ...LOGIN, email: 'nobody@example.com' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    expect(wrong.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects NoSQL operator injection in the email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: { $gt: '' }, password: CREDS.password });
    expect(res.status).toBe(422);
    expect(res.body.data).toBeUndefined();
  });

  it('rejects a password object and unknown fields', async () => {
    const a = await login({ email: CREDS.email, password: { $ne: '' } });
    const b = await login({ ...LOGIN, admin: true });
    expect(a.status).toBe(422);
    expect(b.status).toBe(422);
  });

  it('returns 403 ACCOUNT_SUSPENDED only after the password is verified', async () => {
    await User.updateOne({ email: CREDS.email }, { status: 'suspended' });
    const ok = await login();
    expect(ok.status).toBe(403);
    expect(ok.body.error.code).toBe('ACCOUNT_SUSPENDED');
    const wrong = await login({ ...LOGIN, password: 'Wrong!pass99' });
    expect(wrong.status).toBe(401); // does not reveal the suspension to someone without the password
  });

  // Acceptance: "11th login attempt in 15 min from the same IP+email returns 429"
  it('returns 429 with Retry-After on the 11th attempt for the same IP + email', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await login({ ...LOGIN, password: 'Wrong!pass99' });
      expect(res.status).toBe(401);
    }
    const blocked = await login(); // even the correct password is refused now
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    const otherEmail = await login({ ...LOGIN, email: 'other@example.com' });
    expect(otherEmail.status).toBe(401); // a different email has its own bucket
  });
});

describe('access tokens', () => {
  it('GET /auth/me returns the current user', async () => {
    const { body } = await register();
    const res = await request(app).get('/api/v1/auth/me').set(bearer(body.data.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(CREDS.email);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('401 UNAUTHENTICATED with no token, a malformed header, or a garbage token', async () => {
    for (const header of [undefined, 'Bearer', 'Basic abc', 'Bearer not.a.jwt']) {
      const req = request(app).get('/api/v1/auth/me');
      const res = await (header ? req.set('Authorization', header) : req);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('401 TOKEN_EXPIRED for an expired token', async () => {
    const { body } = await register();
    const expired = jwt.sign({ role: 'customer' }, TEST_AUTH_CONFIG.jwtSecret, {
      subject: body.data.user.id,
      expiresIn: -10,
    });
    const res = await request(app).get('/api/v1/auth/me').set(bearer(expired));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('rejects tokens signed with another secret or with alg=none', async () => {
    const forged = jwt.sign({ role: 'admin' }, 'another-secret-another-secret-12345', {
      subject: 'x',
    });
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(
      '{"sub":"x","role":"admin"}',
    ).toString('base64url')}.`;
    for (const token of [forged, none]) {
      const res = await request(app).get('/api/v1/auth/me').set(bearer(token));
      expect(res.status).toBe(401);
    }
  });
});

describe('POST /auth/refresh', () => {
  it('rotates the refresh token and issues a working access token', async () => {
    const first = await register();
    const oldToken = cookieValue(first);

    const res = await refresh(oldToken);
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(CREDS.email);
    const newToken = cookieValue(res);
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(oldToken);

    const me = await request(app).get('/api/v1/auth/me').set(bearer(res.body.data.accessToken));
    expect(me.status).toBe(200);

    const rows = await RefreshToken.find({}).lean();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.familyId)).size).toBe(1); // same family
    expect(rows.every((r) => !JSON.stringify(r).includes(oldToken))).toBe(true); // only hashes stored
  });

  // Acceptance: "replaying an old refresh token revokes the family and returns 401"
  it('reuse of a rotated token returns 401 and revokes the whole family', async () => {
    const first = await register();
    const oldToken = cookieValue(first);
    const rotated = await refresh(oldToken);
    const newToken = cookieValue(rotated);

    const replay = await refresh(oldToken);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('UNAUTHENTICATED');

    // the legitimate, newest token is dead too
    expect((await refresh(newToken)).status).toBe(401);
    expect(await RefreshToken.countDocuments({ revokedAt: null })).toBe(0);
  });

  it("only revokes the compromised family, not the user's other sessions", async () => {
    const phone = await register();
    const laptop = await login();
    const phoneOld = cookieValue(phone);
    await refresh(phoneOld);
    await refresh(phoneOld); // replay -> phone family revoked

    expect((await refresh(cookieValue(laptop))).status).toBe(200);
  });

  it('is atomic: concurrent use of one token succeeds at most once', async () => {
    const token = cookieValue(await register());
    const results = await Promise.all(Array.from({ length: 5 }, () => refresh(token)));
    expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
    expect(results.every((r) => [200, 401].includes(r.status))).toBe(true);
  });

  it('401 with no cookie, an unknown token, or an expired token', async () => {
    expect((await request(app).post('/api/v1/auth/refresh')).status).toBe(401);
    expect((await refresh('unknown-token')).status).toBe(401);

    const token = cookieValue(await register());
    await RefreshToken.updateOne(
      { tokenHash: hashToken(token) },
      { expiresAt: new Date(Date.now() - 1000) },
    );
    expect((await refresh(token)).status).toBe(401);
  });

  it('rejects a browser Origin that is not allowlisted (CSRF defence), allows the real one', async () => {
    const token = cookieValue(await register());
    const evil = await refresh(token).set('Origin', 'https://evil.example');
    expect(evil.status).toBe(403);
    const good = await refresh(token).set('Origin', ORIGIN);
    expect(good.status).toBe(200);
  });

  it('refuses a suspended user and revokes the family', async () => {
    const token = cookieValue(await register());
    await User.updateOne({ email: CREDS.email }, { status: 'suspended' });
    const res = await refresh(token);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect(await RefreshToken.countDocuments({ revokedAt: null })).toBe(0);
  });
});

describe('POST /auth/logout', () => {
  it('revokes the session, clears the cookie, and the token no longer refreshes', async () => {
    const token = cookieValue(await register());
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', `refreshToken=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie'].join(';')).toMatch(/refreshToken=;/);
    expect((await refresh(token)).status).toBe(401);
  });

  it('is idempotent without a cookie', async () => {
    const res = await request(app).post('/api/v1/auth/logout');
    expect(res.status).toBe(200);
  });

  it('rejects a foreign Origin', async () => {
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });
});

describe('POST /auth/change-password', () => {
  const NEW = 'An0ther!pass77';
  const change = (access, body, token) => {
    const req = request(app).post('/api/v1/auth/change-password').set(bearer(access));
    return (token ? req.set('Cookie', `refreshToken=${token}`) : req).send(body);
  };

  it('changes the password and revokes other sessions but keeps the current one', async () => {
    const phone = await register();
    const laptop = await login();
    const res = await change(
      phone.body.data.accessToken,
      { currentPassword: CREDS.password, newPassword: NEW },
      cookieValue(phone),
    );
    expect(res.status).toBe(200);

    expect((await login()).status).toBe(401); // old password dead
    expect((await login({ ...LOGIN, password: NEW })).status).toBe(200);
    expect((await refresh(cookieValue(laptop))).status).toBe(401); // other session revoked
    expect((await refresh(cookieValue(phone))).status).toBe(200); // current session kept
  });

  it('422 for a wrong current password, with a field path', async () => {
    const { body } = await register();
    const res = await change(body.data.accessToken, {
      currentPassword: 'Nope!pass123',
      newPassword: NEW,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].path).toBe('body.currentPassword');
  });

  it('422 for a weak or unchanged new password', async () => {
    const { body } = await register();
    const weak = await change(body.data.accessToken, {
      currentPassword: CREDS.password,
      newPassword: 'short',
    });
    const same = await change(body.data.accessToken, {
      currentPassword: CREDS.password,
      newPassword: CREDS.password,
    });
    expect(weak.status).toBe(422);
    expect(same.status).toBe(422);
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: 'x', newPassword: NEW });
    expect(res.status).toBe(401);
  });
});

// Acceptance (TESTING.md): "passwordHash, tokens, secrets never in any response or log"
describe('log hygiene', () => {
  it('never writes passwords or tokens to the logs', async () => {
    const lines = [];
    const logger = createLogger(
      { level: 'trace', nodeEnv: 'test' },
      { write: (l) => lines.push(l) },
    );
    const logged = buildTestApp({ logger });

    const reg = await request(logged).post('/api/v1/auth/register').send(CREDS);
    const refreshToken = cookieValue(reg);
    await request(logged).post('/api/v1/auth/login').send(LOGIN);
    await request(logged)
      .get('/api/v1/auth/me')
      .set(bearer(reg.body.data.accessToken))
      .set('Cookie', `refreshToken=${refreshToken}`);
    await request(logged)
      .post('/api/v1/auth/login')
      .send({ ...LOGIN, password: 'Wrong!pass99' });

    const output = lines.join('');
    expect(output.length).toBeGreaterThan(0); // we really captured something
    for (const secret of [
      CREDS.password,
      'Wrong!pass99',
      reg.body.data.accessToken,
      refreshToken,
    ]) {
      expect(output).not.toContain(secret);
    }
  });
});
