import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { Vendor } from '../src/modules/shops/shops.model.js';
import { User } from '../src/modules/users/users.model.js';
import { createMockLedger } from '../src/providers/payment/mockLedger.js';
import { linkAccount, LinkAccountError } from '../src/scripts/linkAccount.js';
import { clearDb, startTestDb, stopTestDb } from './db.js';
import { makeAdmin, makeVendor, signUp } from './factories.js';
import { buildTestApp } from './helpers.js';

let replSet;
let app;
let provider;
beforeAll(async () => {
  replSet = await startTestDb();
}, 60_000);
afterAll(() => stopTestDb(replSet));
beforeEach(async () => {
  await clearDb();
  provider = createMockLedger();
  app = buildTestApp({ paymentProvider: provider });
});

async function world() {
  const admin = await makeAdmin(app, 'root@example.com');
  const vendor = await makeVendor(app, 'v1@example.com', { approved: true, shopName: 'Shop One' });
  const vendor2 = await makeVendor(app, 'v2@example.com', { approved: true, shopName: 'Shop Two' });
  return { admin, vendor, vendor2, mock: (v) => `acc_mock${v.shop.id}` };
}
const run = (args, deps = { paymentProvider: provider }) => linkAccount(args, deps);
const expectError = async (promise, code) => {
  const err = await promise.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(LinkAccountError);
  expect(err.code).toBe(code);
};

describe('linkAccount (D49)', () => {
  it('attaches the account, activates the payout account and writes one audit entry', async () => {
    const { vendor, mock } = await world();
    const res = await run({
      vendorRef: vendor.shop.id,
      accountId: mock(vendor),
      adminEmail: 'root@example.com',
    });
    expect(res).toMatchObject({ status: 'attached', previousLinkedAccountId: null });
    const saved = await Vendor.findById(vendor.shop.id);
    expect(saved.payoutAccount).toMatchObject({
      provider: 'razorpay',
      linkedAccountId: mock(vendor),
      status: 'active',
    });

    const entries = await AuditLog.find({ entityType: 'vendor', entityId: vendor.shop.id });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'vendor.payout_account_attached',
      actorRole: 'admin',
    });
    expect(entries[0].meta).toEqual({
      previousLinkedAccountId: null,
      linkedAccountId: mock(vendor),
    });
    const admin = await User.findOne({ email: 'root@example.com' });
    expect(String(entries[0].actorId)).toBe(admin.id);
  });

  it('finds the vendor by shop slug and treats the same account again as a no-op', async () => {
    const { vendor, mock } = await world();
    const args = {
      vendorRef: vendor.shop.shopSlug,
      accountId: mock(vendor),
      adminEmail: 'ROOT@example.com',
    };
    expect((await run(args)).status).toBe('attached');
    expect((await run(args)).status).toBe('unchanged');
    expect(await AuditLog.countDocuments()).toBe(1);
  });

  it('refuses to change an active account without --replace, and audits a replacement', async () => {
    const { vendor, mock } = await world();
    const base = { vendorRef: vendor.shop.id, adminEmail: 'root@example.com' };
    await run({ ...base, accountId: mock(vendor) });
    // a second, different account id that the provider accepts for this vendor
    provider.validateLinkedAccount = async () => ({ ok: true });
    await expectError(run({ ...base, accountId: 'acc_second1' }), 'ACCOUNT_ALREADY_SET');
    expect((await Vendor.findById(vendor.shop.id)).payoutAccount.linkedAccountId).toBe(
      mock(vendor),
    );

    const res = await run({ ...base, accountId: 'acc_second1', replace: true });
    expect(res).toMatchObject({ status: 'replaced', previousLinkedAccountId: mock(vendor) });
    expect(await AuditLog.countDocuments()).toBe(2);
    const last = await AuditLog.findOne().sort({ createdAt: -1 });
    expect(last.meta).toEqual({
      previousLinkedAccountId: mock(vendor),
      linkedAccountId: 'acc_second1',
    });
  });

  describe('changes nothing and writes no audit entry when', () => {
    const untouched = async (vendor) => {
      expect(await AuditLog.countDocuments()).toBe(0);
      expect((await Vendor.findById(vendor.shop.id)).payoutAccount.linkedAccountId).toBeUndefined();
    };

    it('the actor is not an admin (customer, vendor, suspended admin, unknown email)', async () => {
      const { vendor, mock } = await world();
      await signUp(app, 'customer@example.com');
      const args = { vendorRef: vendor.shop.id, accountId: mock(vendor) };
      await expectError(run({ ...args, adminEmail: 'customer@example.com' }), 'ADMIN_NOT_FOUND');
      await expectError(run({ ...args, adminEmail: 'v1@example.com' }), 'ADMIN_NOT_FOUND');
      await expectError(run({ ...args, adminEmail: 'nobody@example.com' }), 'ADMIN_NOT_FOUND');
      await expectError(run({ ...args, adminEmail: undefined }), 'ADMIN_NOT_FOUND');
      await User.updateOne({ email: 'root@example.com' }, { status: 'suspended' });
      await expectError(run({ ...args, adminEmail: 'root@example.com' }), 'ADMIN_NOT_FOUND');
      await untouched(vendor);
    });

    it('the vendor is unknown, not approved, or its owner is suspended', async () => {
      const { vendor, mock } = await world();
      const admin = { adminEmail: 'root@example.com' };
      await expectError(
        run({ ...admin, vendorRef: '0'.repeat(24), accountId: 'acc_abc123' }),
        'VENDOR_NOT_FOUND',
      );
      await expectError(
        run({ ...admin, vendorRef: 'no-such-shop', accountId: 'acc_abc123' }),
        'VENDOR_NOT_FOUND',
      );
      await Vendor.updateOne({ _id: vendor.shop.id }, { status: 'pending' });
      await expectError(
        run({ ...admin, vendorRef: vendor.shop.id, accountId: mock(vendor) }),
        'VENDOR_NOT_APPROVED',
      );
      await Vendor.updateOne({ _id: vendor.shop.id }, { status: 'approved' });
      await User.updateOne({ email: 'v1@example.com' }, { status: 'suspended' });
      await expectError(
        run({ ...admin, vendorRef: vendor.shop.id, accountId: mock(vendor) }),
        'VENDOR_USER_INACTIVE',
      );
      await untouched(vendor);
    });

    it('the account id is malformed or not accepted by the provider', async () => {
      const { vendor } = await world();
      const base = { vendorRef: vendor.shop.id, adminEmail: 'root@example.com' };
      for (const bad of [
        '',
        'acc_',
        'ACC_123',
        'acc 123',
        'rzp_test_1',
        undefined,
        "acc_1'; drop",
      ]) {
        await expectError(run({ ...base, accountId: bad }), 'INVALID_ACCOUNT_ID');
      }
      await expectError(run({ ...base, accountId: 'acc_notmine1' }), 'ACCOUNT_REJECTED');
      await untouched(vendor);
    });

    it('the account already belongs to another vendor', async () => {
      const { vendor, vendor2, mock } = await world();
      const base = { adminEmail: 'root@example.com' };
      await run({ ...base, vendorRef: vendor.shop.id, accountId: mock(vendor) });
      provider.validateLinkedAccount = async () => ({ ok: true });
      await expectError(
        run({ ...base, vendorRef: vendor2.shop.id, accountId: mock(vendor) }),
        'ACCOUNT_IN_USE',
      );
      expect(
        (await Vendor.findById(vendor2.shop.id)).payoutAccount.linkedAccountId,
      ).toBeUndefined();
      expect(await AuditLog.countDocuments()).toBe(1);
    });

    it('the audit entry cannot be written (the vendor update rolls back with it)', async () => {
      const { vendor, mock } = await world();
      const audit = {
        record: async () => {
          throw new Error('audit down');
        },
      };
      await expect(
        linkAccount(
          { vendorRef: vendor.shop.id, accountId: mock(vendor), adminEmail: 'root@example.com' },
          { paymentProvider: provider, audit },
        ),
      ).rejects.toThrow('audit down');
      await untouched(vendor);
    });
  });
});
