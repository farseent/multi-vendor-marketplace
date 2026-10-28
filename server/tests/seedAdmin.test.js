import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAdmin } from '../src/scripts/seedAdmin.js';
import { User } from '../src/modules/users/users.model.js';
import { clearDb, startTestDb, stopTestDb } from './db.js';

let replSet;
beforeAll(async () => {
  replSet = await startTestDb();
}, 60_000);
afterAll(() => stopTestDb(replSet));
beforeEach(clearDb);

const ENV = {
  MONGODB_URI: 'mongodb://localhost/x',
  ADMIN_SEED_EMAIL: 'Admin@Example.com',
  ADMIN_SEED_PASSWORD: 'Adm1n!password',
  BCRYPT_COST: '12',
};

describe('seedAdmin', () => {
  it('creates an admin with a cost-12 bcrypt hash', async () => {
    const { created, user } = await seedAdmin(ENV);
    expect(created).toBe(true);
    expect(user).toMatchObject({
      email: 'admin@example.com',
      role: 'admin',
      name: 'Platform Admin',
    });
    const stored = await User.findOne({ email: 'admin@example.com' }).select('+passwordHash');
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$12\$/);
  });

  it('is idempotent', async () => {
    await seedAdmin(ENV);
    expect((await seedAdmin(ENV)).created).toBe(false);
    expect(await User.countDocuments({ role: 'admin' })).toBe(1);
  });

  it('refuses to promote an existing non-admin account', async () => {
    await User.create({
      name: 'Cust',
      email: 'admin@example.com',
      passwordHash: 'x',
      role: 'customer',
    });
    await expect(seedAdmin(ENV)).rejects.toThrow(/non-admin/);
    expect((await User.findOne({ email: 'admin@example.com' })).role).toBe('customer');
  });

  it('rejects a weak password or bad email, naming the variable but not its value', async () => {
    const weak = { ...ENV, ADMIN_SEED_PASSWORD: 'short' };
    await expect(seedAdmin(weak)).rejects.toThrow('ADMIN_SEED_PASSWORD');
    await expect(seedAdmin(weak)).rejects.not.toThrow(/short$/);
    await expect(seedAdmin({ ...ENV, ADMIN_SEED_EMAIL: 'nope' })).rejects.toThrow(
      'ADMIN_SEED_EMAIL',
    );
    await expect(seedAdmin({})).rejects.toThrow('ADMIN_SEED_PASSWORD');
  });
});
