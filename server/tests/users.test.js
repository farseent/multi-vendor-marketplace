import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearDb, startTestDb, stopTestDb } from './db.js';
import { buildTestApp } from './helpers.js';

let replSet;
let app;
beforeAll(async () => {
  replSet = await startTestDb();
}, 60_000);
afterAll(() => stopTestDb(replSet));

const ADDRESS = {
  label: 'Home',
  name: 'Asha K',
  phone: '+919876543210',
  line1: '12 Lake Rd',
  city: 'Kochi',
  state: 'Kerala',
  postalCode: '682001',
};

async function signUp(email, path = 'register') {
  const res = await request(app)
    .post(`/api/v1/auth/${path}`)
    .send({ name: 'Test User', email, password: 'S3cure!pass99' });
  return {
    id: res.body.data.user.id,
    auth: { Authorization: `Bearer ${res.body.data.accessToken}` },
  };
}

beforeEach(async () => {
  await clearDb();
  app = buildTestApp();
});

describe('/users/me', () => {
  it('returns and updates the profile (name, phone); null clears the phone', async () => {
    const { auth } = await signUp('a@example.com');
    const patch = await request(app)
      .patch('/api/v1/users/me')
      .set(auth)
      .send({ name: 'New Name', phone: '+919876543210' });
    expect(patch.status).toBe(200);
    expect(patch.body.data.user).toMatchObject({ name: 'New Name', phone: '+919876543210' });

    const cleared = await request(app).patch('/api/v1/users/me').set(auth).send({ phone: null });
    expect(cleared.body.data.user.phone).toBeUndefined();

    const get = await request(app).get('/api/v1/users/me').set(auth);
    expect(get.body.data.user.name).toBe('New Name');
    expect(JSON.stringify(get.body)).not.toContain('passwordHash');
  });

  it('cannot change role, status or email through PATCH (strict body)', async () => {
    const { auth } = await signUp('a@example.com');
    for (const body of [{ role: 'admin' }, { status: 'active' }, { email: 'x@example.com' }, {}]) {
      const res = await request(app).patch('/api/v1/users/me').set(auth).send(body);
      expect(res.status).toBe(422);
    }
    const me = await request(app).get('/api/v1/users/me').set(auth);
    expect(me.body.data.user.role).toBe('customer');
  });

  it('rejects an invalid phone', async () => {
    const { auth } = await signUp('a@example.com');
    const res = await request(app).patch('/api/v1/users/me').set(auth).send({ phone: 'abc' });
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].path).toBe('body.phone');
  });

  it('vendors can use /users/me (role "Any")', async () => {
    const { auth } = await signUp('v@example.com', 'register-vendor');
    expect((await request(app).get('/api/v1/users/me').set(auth)).status).toBe(200);
  });
});

describe('/users/me/addresses', () => {
  const add = (auth, body = ADDRESS) =>
    request(app).post('/api/v1/users/me/addresses').set(auth).send(body);

  it('creates an address (first one becomes default) and lists it', async () => {
    const { auth } = await signUp('a@example.com');
    const created = await add(auth);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ ...ADDRESS, country: 'IN', isDefault: true });
    expect(created.body.data.id).toMatch(/^[a-f0-9]{24}$/);
    expect(created.body.data._id).toBeUndefined();

    const list = await request(app).get('/api/v1/users/me/addresses').set(auth);
    expect(list.body.data).toHaveLength(1);
  });

  it('keeps exactly one default as addresses are added, changed and deleted', async () => {
    const { auth } = await signUp('a@example.com');
    const a = (await add(auth)).body.data;
    const b = (await add(auth, { ...ADDRESS, label: 'Work', isDefault: true })).body.data;
    const c = (await add(auth, { ...ADDRESS, label: 'Other' })).body.data;
    expect(b.isDefault).toBe(true);
    expect(c.isDefault).toBe(false);

    const defaults = async () =>
      (await request(app).get('/api/v1/users/me/addresses').set(auth)).body.data
        .filter((x) => x.isDefault)
        .map((x) => x.label);
    expect(await defaults()).toEqual(['Work']);

    await request(app)
      .patch(`/api/v1/users/me/addresses/${c.id}`)
      .set(auth)
      .send({ isDefault: true });
    expect(await defaults()).toEqual(['Other']);

    // PATCH of another field must not reset the default flag
    await request(app).patch(`/api/v1/users/me/addresses/${c.id}`).set(auth).send({ city: 'Pune' });
    expect(await defaults()).toEqual(['Other']);

    await request(app).delete(`/api/v1/users/me/addresses/${c.id}`).set(auth);
    expect(await defaults()).toHaveLength(1); // a remaining address was promoted
    expect([a.id, b.id]).toContain(
      (await request(app).get('/api/v1/users/me/addresses').set(auth)).body.data.find(
        (x) => x.isDefault,
      ).id,
    );
  });

  it('allows at most 5 addresses (409)', async () => {
    const { auth } = await signUp('a@example.com');
    for (let i = 0; i < 5; i++) expect((await add(auth)).status).toBe(201);
    const sixth = await add(auth);
    expect(sixth.status).toBe(409);
    expect(sixth.body.error.code).toBe('CONFLICT');
  });

  it.each([
    ['postal code not 6 digits', { postalCode: '1234' }],
    ['bad phone', { phone: '12' }],
    ['unknown field', { isAdmin: true }],
    ['country other than IN', { country: 'US' }],
  ])('rejects an invalid address: %s', async (_label, bad) => {
    const { auth } = await signUp('a@example.com');
    expect((await add(auth, { ...ADDRESS, ...bad })).status).toBe(422);
  });

  it('rejects a missing required field with its path', async () => {
    const { auth } = await signUp('a@example.com');
    const incomplete = { ...ADDRESS };
    delete incomplete.city;
    const res = await add(auth, incomplete);
    expect(res.status).toBe(422);
    expect(res.body.error.details.map((d) => d.path)).toContain('body.city');
  });

  // Cross-tenant: customer A vs customer B (TESTING.md section 2)
  it("returns 404 when customer B touches customer A's address", async () => {
    const a = await signUp('a@example.com');
    const b = await signUp('b@example.com');
    const addr = (await add(a.auth)).body.data;

    const patch = await request(app)
      .patch(`/api/v1/users/me/addresses/${addr.id}`)
      .set(b.auth)
      .send({ city: 'Hacked' });
    const del = await request(app).delete(`/api/v1/users/me/addresses/${addr.id}`).set(b.auth);
    expect(patch.status).toBe(404);
    expect(del.status).toBe(404);

    const still = await request(app).get('/api/v1/users/me/addresses').set(a.auth);
    expect(still.body.data[0].city).toBe('Kochi');
  });

  it('422 for a malformed address id, 404 for an unknown one', async () => {
    const { auth } = await signUp('a@example.com');
    expect(
      (await request(app).delete('/api/v1/users/me/addresses/not-an-id').set(auth)).status,
    ).toBe(422);
    const unknown = '0'.repeat(24);
    expect(
      (await request(app).delete(`/api/v1/users/me/addresses/${unknown}`).set(auth)).status,
    ).toBe(404);
  });

  it('is customer-only: vendors get 403', async () => {
    const { auth } = await signUp('v@example.com', 'register-vendor');
    expect((await request(app).get('/api/v1/users/me/addresses').set(auth)).status).toBe(403);
    expect((await add(auth)).status).toBe(403);
  });
});
