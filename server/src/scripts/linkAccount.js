import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { createAuditService } from '../modules/audit/audit.service.js';
import { Vendor } from '../modules/shops/shops.model.js';
import { User } from '../modules/users/users.model.js';

const ACCOUNT_ID = /^acc_[A-Za-z0-9]+$/;
const OBJECT_ID = /^[a-f0-9]{24}$/i;

export class LinkAccountError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LinkAccountError';
    this.code = code;
  }
}
const fail = (code, message) => new LinkAccountError(code, message);

/**
 * Attaches a payout (linked) account to a vendor (DECISIONS D49). Admin-only, run from the CLI
 * below. Nothing is changed unless EVERY check passes; the vendor update and its audit entry
 * commit together or not at all.
 *
 * Returns { status: 'attached' | 'replaced' | 'unchanged', vendorId, previousLinkedAccountId }.
 */
export async function linkAccount(
  { vendorRef, accountId, adminEmail, replace = false },
  { paymentProvider, audit = createAuditService() },
) {
  // 1. who is acting
  const admin = await User.findOne({
    email: String(adminEmail ?? '')
      .trim()
      .toLowerCase(),
    role: 'admin',
    status: 'active',
  });
  if (!admin) throw fail('ADMIN_NOT_FOUND', 'The --admin email must belong to an active admin');

  // 2. the vendor
  const ref = String(vendorRef ?? '').trim();
  const vendor = OBJECT_ID.test(ref)
    ? await Vendor.findById(ref)
    : await Vendor.findOne({ shopSlug: ref.toLowerCase() });
  if (!vendor) throw fail('VENDOR_NOT_FOUND', 'No vendor with that id or shop slug');
  if (vendor.status !== 'approved') {
    throw fail(
      'VENDOR_NOT_APPROVED',
      `The shop is ${vendor.status}; only approved vendors can be paid`,
    );
  }
  const owner = await User.findById(vendor.userId);
  if (!owner || owner.status !== 'active') {
    throw fail('VENDOR_USER_INACTIVE', 'The shop owner account is not active');
  }

  // 3. the account
  if (!ACCOUNT_ID.test(String(accountId ?? ''))) {
    throw fail('INVALID_ACCOUNT_ID', 'The account id must look like acc_XXXXXXXX');
  }
  const check = await paymentProvider.validateLinkedAccount({ vendor, linkedAccountId: accountId });
  if (!check?.ok) {
    throw fail(
      'ACCOUNT_REJECTED',
      `The payment provider does not accept that account (${check?.reason ?? 'unknown'})`,
    );
  }
  const takenBy = await Vendor.findOne({
    _id: { $ne: vendor._id },
    'payoutAccount.linkedAccountId': accountId,
  });
  if (takenBy) throw fail('ACCOUNT_IN_USE', 'That account is already attached to another vendor');

  // 4. replacing
  const previous = vendor.payoutAccount?.linkedAccountId ?? null;
  const hasActive = previous && vendor.payoutAccount.status === 'active';
  if (hasActive && previous === accountId) {
    return { status: 'unchanged', vendorId: vendor.id, previousLinkedAccountId: previous };
  }
  if (hasActive && !replace) {
    throw fail(
      'ACCOUNT_ALREADY_SET',
      'The vendor already has an active account; pass --replace to change it',
    );
  }

  // 5. write + audit, atomically
  await mongoose.connection.transaction(async (session) => {
    await Vendor.updateOne(
      { _id: vendor._id },
      {
        $set: {
          'payoutAccount.provider': 'razorpay',
          'payoutAccount.linkedAccountId': accountId,
          'payoutAccount.status': 'active',
        },
      },
      { session },
    );
    await audit.record(
      { id: admin.id, role: 'admin' },
      {
        action: 'vendor.payout_account_attached',
        entityType: 'vendor',
        entityId: vendor._id,
        meta: { previousLinkedAccountId: previous, linkedAccountId: accountId },
      },
      { session },
    );
  });
  return {
    status: hasActive ? 'replaced' : 'attached',
    vendorId: vendor.id,
    previousLinkedAccountId: previous,
  };
}

// CLI: npm run link-account -w server -- --vendor <vendorId|shopSlug> --account <acc_id> --admin <email> [--replace]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { connectMongo, disconnectMongo } = await import('../lib/db.js');
  try {
    const { values } = parseArgs({
      options: {
        vendor: { type: 'string' },
        account: { type: 'string' },
        admin: { type: 'string' },
        replace: { type: 'boolean', default: false },
      },
    });
    const { parseEnv } = await import('../config/env.js');
    const { createPaymentProvider } = await import('../providers/payment/index.js');
    const env = parseEnv(process.env);
    await connectMongo({ uri: env.MONGODB_URI, logger: { info: console.log, warn: console.warn } });
    const result = await linkAccount(
      {
        vendorRef: values.vendor,
        accountId: values.account,
        adminEmail: values.admin,
        replace: values.replace,
      },
      { paymentProvider: createPaymentProvider(env) },
    );
    console.log(
      result.status === 'unchanged'
        ? `Vendor ${result.vendorId} already has ${values.account}; nothing changed`
        : `Vendor ${result.vendorId}: payout account ${result.status} (${values.account})`,
    );
  } catch (err) {
    console.error(err instanceof LinkAccountError ? `${err.code}: ${err.message}` : err.message);
    process.exitCode = 1;
  } finally {
    await disconnectMongo();
  }
}
