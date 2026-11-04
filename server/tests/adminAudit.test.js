import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { Review } from '../src/modules/reviews/reviews.model.js';
import { createMockLedger } from '../src/providers/payment/mockLedger.js';
import { clearDb, startTestDb, stopTestDb } from './db.js';
import { makeAdmin, makeCategory, makeVendor } from './factories.js';
import { createFakeSearchIndex } from './fakeSearch.js';
import { buildTestApp, listApiRoutes } from './helpers.js';
import { api, makeCoupon, makeCustomerDirect } from './phase5.helpers.js';
import { deliver, paidOrder } from './phase6.helpers.js';

// Acceptance (Phase 8): "Every admin mutation creates an auditLogs entry (route-table test)".
// The table below has one successful call for EVERY mutating /admin route. A second test reads the
// registered route table and fails if a route exists that is not in the table (a new admin
// mutation cannot be added without also proving it is audited), or if the table names a route
// that no longer exists.

let replSet;
let app;
let admin;
let fixtures;

beforeAll(async () => {
  replSet = await startTestDb();
  await clearDb();
  const ledger = createMockLedger();
  app = buildTestApp({ paymentProvider: ledger, searchIndex: createFakeSearchIndex() });
  admin = await makeAdmin(app);

  // One paid order with two vendors: sub-order 0 gets refunded, sub-order 1 is delivered so its
  // settlement can be released early. (The register limit is 5 sign-ups per hour per IP, so the
  // setup reuses this order's vendors, products and customer instead of signing up more.)
  const order = await paidOrder(app, ledger, { vendorCount: 2 });
  await deliver(app, order.vendors[1], order.subs[1].id);
  const { Settlement } = await import('../src/modules/settlements/settlements.model.js');
  const settlement = await Settlement.findOne({ subOrderId: order.subs[1].id });

  const category = await makeCategory();
  const pendingVendor = await makeVendor(app, 'pending@example.com'); // not approved yet
  const coupon = await makeCoupon({ code: 'AUDITME', scope: 'platform', fundedBy: 'platform' });
  const reviewer = await makeCustomerDirect('reviewer@example.com');
  const review = await Review.create({
    productId: order.products[0].id,
    vendorId: order.vendors[0].shop.id,
    customerId: reviewer.id,
    subOrderId: order.subs[0].id,
    rating: 4,
    body: 'A perfectly fine review.',
  });
  fixtures = {
    category,
    pendingVendor,
    product: order.products[0],
    coupon,
    review,
    order,
    settlement,
  };
}, 120_000);
afterAll(() => stopTestDb(replSet));

const day = 86_400_000;
const call = (method, path, body, headers) => {
  const req = api(app, method, path, admin.auth, body);
  return headers ? req.set(headers) : req;
};

// route key -> { action it must log, a function that performs one successful call }
const MUTATIONS = {
  'POST /api/v1/admin/categories': {
    action: 'category.created',
    run: () => call('post', '/admin/categories', { name: 'Audited Category' }),
  },
  'PATCH /api/v1/admin/categories/:categoryId': {
    action: 'category.updated',
    run: () =>
      call('patch', `/admin/categories/${fixtures.category.id}`, { name: 'Renamed Category' }),
  },
  'PATCH /api/v1/admin/vendors/:vendorId/status': {
    action: 'vendor.status_changed',
    run: () =>
      call('patch', `/admin/vendors/${fixtures.pendingVendor.shop.id}/status`, {
        status: 'approved',
      }),
  },
  'PATCH /api/v1/admin/vendors/:vendorId/commission': {
    action: 'vendor.commission_changed',
    run: () =>
      call('patch', `/admin/vendors/${fixtures.pendingVendor.shop.id}/commission`, {
        commissionRateBps: 1500,
      }),
  },
  'POST /api/v1/admin/coupons': {
    action: 'coupon.created',
    run: () =>
      call('post', '/admin/coupons', {
        code: 'NEWAUDIT',
        type: 'percent',
        value: 10,
        startsAt: new Date(Date.now() - day).toISOString(),
        expiresAt: new Date(Date.now() + day).toISOString(),
      }),
  },
  'PATCH /api/v1/admin/coupons/:couponId': {
    action: 'coupon.updated',
    run: () => call('patch', `/admin/coupons/${fixtures.coupon.id}`, { status: 'disabled' }),
  },
  'PATCH /api/v1/admin/products/:productId/status': {
    action: 'product.status_changed',
    run: () =>
      call('patch', `/admin/products/${fixtures.product.id}/status`, { status: 'suspended' }),
  },
  'PATCH /api/v1/admin/reviews/:reviewId/status': {
    action: 'review.status_changed',
    run: () => call('patch', `/admin/reviews/${fixtures.review.id}/status`, { status: 'hidden' }),
  },
  'POST /api/v1/admin/sub-orders/:subOrderId/refund': {
    action: 'refund.created',
    run: () =>
      call(
        'post',
        `/admin/sub-orders/${fixtures.order.subs[0].id}/refund`,
        { reason: 'admin', note: 'Audit check', amountPaise: 5000 },
        { 'Idempotency-Key': 'audit-refund-1' },
      ),
  },
  'POST /api/v1/admin/settlements/:settlementId/release': {
    action: 'settlement.released',
    run: () => call('post', `/admin/settlements/${fixtures.settlement.id}/release`),
  },
  'POST /api/v1/admin/reconciliation/run': {
    action: 'reconciliation.run',
    run: () => call('post', '/admin/reconciliation/run'),
  },
  'POST /api/v1/admin/search/reindex': {
    action: 'search.reindexed',
    run: () => call('post', '/admin/search/reindex'),
  },
};

const mutatingAdminRoutes = () =>
  listApiRoutes(buildTestApp())
    .filter((r) => r.path.startsWith('/api/v1/admin/') && r.method !== 'GET')
    .map((r) => `${r.method} ${r.path}`);

describe('every admin mutation is audited (route table)', () => {
  it('the table covers exactly the mutating /admin routes that are registered', () => {
    expect(Object.keys(MUTATIONS).sort()).toEqual(mutatingAdminRoutes().sort());
  });

  it.each(Object.entries(MUTATIONS))('%s writes an auditLogs entry', async (_route, m) => {
    const before = await AuditLog.countDocuments({ action: m.action });
    const res = await m.run();
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const entries = await AuditLog.find({ action: m.action });
    expect(entries.length).toBe(before + 1);
    const entry = entries.at(-1);
    expect(entry.actorRole).toBe('admin');
    expect(String(entry.actorId)).toBe(admin.id);
    expect(entry.entityType).toBeTruthy();
    expect(entry.entityId).toBeTruthy();
  });
});
