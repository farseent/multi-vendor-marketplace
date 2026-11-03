import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { Product } from '../src/modules/catalog/products.model.js';
import { SearchOutbox } from '../src/modules/search/search.model.js';
import { Review } from '../src/modules/reviews/reviews.model.js';
import { User } from '../src/modules/users/users.model.js';
import { clearDb, startTestDb, stopTestDb } from './db.js';
import { makeAdmin, makeVendor } from './factories.js';
import { createFakeRedis } from './fakeSearch.js';
import { buildTestApp } from './helpers.js';
import { addProduct, api, makeCategory, makeCustomerDirect } from './phase5.helpers.js';
import { grantPurchase } from './phase7.helpers.js';

let replSet;
let app;
let redis;
let vendor;
let admin;
let product;
beforeAll(async () => {
  replSet = await startTestDb();
}, 60_000);
afterAll(() => stopTestDb(replSet));
beforeEach(async () => {
  await clearDb();
  redis = createFakeRedis();
  app = buildTestApp({ redis });
  vendor = await makeVendor(app, 'vendor@example.com', { approved: true });
  admin = await makeAdmin(app);
  product = await addProduct(app, vendor, await makeCategory());
});

const GOOD = { rating: 5, title: 'Great fit', body: 'Fabric is lovely and true to size.' };
const post = (customer, body = GOOD, productId = product.id) =>
  api(app, 'post', `/products/${productId}/reviews`, customer.auth, body);
const patch = (customer, reviewId, body) =>
  api(app, 'patch', `/reviews/${reviewId}`, customer.auth, body);
const remove = (customer, reviewId) => api(app, 'delete', `/reviews/${reviewId}`, customer.auth);
const moderate = (reviewId, status) =>
  api(app, 'patch', `/admin/reviews/${reviewId}/status`, admin.auth, { status });

/** A customer who has a delivered order of the shared product. */
async function buyer(email) {
  const customer = await makeCustomerDirect(email);
  await grantPurchase(customer.id, product);
  return customer;
}

const productDoc = () => Product.findById(product.id);

describe('POST /products/:productId/reviews: eligibility (403)', () => {
  it('refuses a customer who never bought the product', async () => {
    const customer = await makeCustomerDirect('nobuy@example.com');
    const res = await post(customer);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(await Review.countDocuments()).toBe(0);
  });

  it.each(['pending_payment', 'processing', 'shipped', 'cancelled'])(
    'refuses a sub-order that is only %s',
    async (fulfillmentStatus) => {
      const customer = await makeCustomerDirect('early@example.com');
      await grantPurchase(customer.id, product, { fulfillmentStatus });
      expect((await post(customer)).status).toBe(403);
    },
  );

  it("refuses when only ANOTHER customer's delivered order contains the product", async () => {
    await buyer('someone@example.com');
    const customer = await makeCustomerDirect('other@example.com');
    expect((await post(customer)).status).toBe(403);
  });

  it('refuses when the delivered order holds a DIFFERENT product', async () => {
    const other = await addProduct(app, vendor, await makeCategory());
    const customer = await makeCustomerDirect('wrong@example.com');
    await grantPurchase(customer.id, other);
    expect((await post(customer)).status).toBe(403);
  });

  it('accepts a delivered purchase and returns the review (201)', async () => {
    const customer = await buyer('ok@example.com');
    const res = await post(customer);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      productId: product.id,
      rating: 5,
      title: 'Great fit',
      status: 'published',
    });
    expect(res.body.data.editableUntil).toBeTruthy();
    const stored = await Review.findOne({ customerId: customer.id });
    expect(String(stored.vendorId)).toBe(vendor.shop.id);
    expect(stored.subOrderId).toBeTruthy();
  });

  it('a fully refunded delivered sub-order still counts (D61)', async () => {
    const customer = await makeCustomerDirect('refunded@example.com');
    await grantPurchase(customer.id, product, { refundedPaise: product.pricePaise });
    expect((await post(customer)).status).toBe(201);
  });

  it('unknown product -> 404; vendor and anonymous callers are refused', async () => {
    const customer = await makeCustomerDirect('c@example.com');
    expect((await post(customer, GOOD, '0'.repeat(24))).status).toBe(404);
    expect(
      (await api(app, 'post', `/products/${product.id}/reviews`, vendor.auth, GOOD)).status,
    ).toBe(403);
    expect(
      (await api(app, 'post', `/products/${product.id}/reviews`, undefined, GOOD)).status,
    ).toBe(401);
  });
});

describe('POST /products/:productId/reviews: uniqueness (409) and validation (422)', () => {
  it('a second review of the same product is 409 REVIEW_EXISTS', async () => {
    const customer = await buyer('twice@example.com');
    expect((await post(customer)).status).toBe(201);
    const again = await post(customer, { ...GOOD, rating: 1 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('REVIEW_EXISTS');
    expect(await Review.countDocuments()).toBe(1);
  });

  it('five simultaneous submissions from one customer create exactly one review', async () => {
    const customer = await buyer('double@example.com');
    const results = await Promise.all(Array.from({ length: 5 }, () => post(customer)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results.filter((r) => r.status !== 201)) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('REVIEW_EXISTS');
    }
    expect(await Review.countDocuments()).toBe(1);
    expect((await productDoc()).ratingCount).toBe(1);
  }, 30_000);

  it.each([
    ['rating 0', { ...GOOD, rating: 0 }],
    ['rating 6', { ...GOOD, rating: 6 }],
    ['fractional rating', { ...GOOD, rating: 4.5 }],
    ['string rating', { ...GOOD, rating: '5' }],
    ['body too short', { ...GOOD, body: 'too short' }],
    ['body too long', { ...GOOD, body: 'x'.repeat(2001) }],
    ['title too long', { ...GOOD, title: 'x'.repeat(101) }],
    ['missing body', { rating: 5 }],
    ['unknown field', { ...GOOD, status: 'hidden' }],
  ])('rejects %s with 422 and stores nothing', async (_name, body) => {
    const customer = await buyer('validation@example.com');
    const res = await post(customer, body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await Review.countDocuments()).toBe(0);
  });

  it('a title is optional', async () => {
    const customer = await buyer('notitle@example.com');
    const res = await post(customer, { rating: 4, body: 'Comfortable and well made.' });
    expect(res.status).toBe(201);
    expect(res.body.data.title).toBeNull();
  });
});

describe('rating aggregates (create, edit, delete, hide, publish)', () => {
  const cacheKey = () => `cache:product:${product.slug}`;

  /** What the average SHOULD be, recomputed from the reviews themselves. */
  async function truth() {
    const rows = await Review.find({ productId: product.id, status: 'published' });
    const count = rows.length;
    const sum = rows.reduce((acc, r) => acc + r.rating, 0);
    return { ratingCount: count, ratingAvg: count ? Math.round((sum * 100) / count) / 100 : 0 };
  }

  /**
   * Runs one operation with the product page cached beforehand, then checks: the stored average,
   * the recomputed truth, a dropped cache entry, a fresh public page, and a queued re-index.
   */
  async function step(operation, expected) {
    expect((await api(app, 'get', `/products/${product.slug}`)).status).toBe(200);
    expect(redis.store.has(cacheKey())).toBe(true); // warm
    await SearchOutbox.deleteMany({});

    await operation();

    expect(redis.store.has(cacheKey())).toBe(false); // invalidated
    expect(await SearchOutbox.countDocuments({ productId: product.id })).toBeGreaterThan(0);
    const stored = await productDoc();
    expect({ ratingAvg: stored.ratingAvg, ratingCount: stored.ratingCount }).toEqual(expected);
    expect(expected).toEqual(await truth());
    const page = await api(app, 'get', `/products/${product.slug}`);
    expect(page.body.data).toMatchObject(expected);
  }

  it('stays correct across seven operations', async () => {
    const a = await buyer('a@example.com');
    const b = await buyer('b@example.com');
    const c = await buyer('c@example.com');
    const ids = {};

    await step(
      async () => {
        ids.a = (await post(a, { ...GOOD, rating: 5 })).body.data.id;
      },
      { ratingAvg: 5, ratingCount: 1 },
    );
    await step(
      async () => {
        ids.b = (await post(b, { ...GOOD, rating: 4 })).body.data.id;
      },
      { ratingAvg: 4.5, ratingCount: 2 },
    );
    await step(
      async () => {
        ids.c = (await post(c, { ...GOOD, rating: 2 })).body.data.id;
      },
      { ratingAvg: 3.67, ratingCount: 3 },
    ); // 11 / 3
    await step(
      async () => {
        expect((await patch(a, ids.a, { rating: 1 })).status).toBe(200);
      },
      { ratingAvg: 2.33, ratingCount: 3 },
    ); // 7 / 3
    await step(
      async () => {
        expect((await moderate(ids.b, 'hidden')).status).toBe(200);
      },
      { ratingAvg: 1.5, ratingCount: 2 },
    ); // (1 + 2) / 2
    await step(
      async () => {
        expect((await remove(c, ids.c)).status).toBe(200);
      },
      { ratingAvg: 1, ratingCount: 1 },
    );
    await step(
      async () => {
        expect((await moderate(ids.b, 'published')).status).toBe(200);
      },
      { ratingAvg: 2.5, ratingCount: 2 },
    ); // (1 + 4) / 2
  }, 60_000);

  it('removing the last review returns the product to 0 / 0', async () => {
    const a = await buyer('only@example.com');
    const id = (await post(a)).body.data.id;
    expect((await productDoc()).ratingCount).toBe(1);
    expect((await remove(a, id)).status).toBe(200);
    expect(await productDoc()).toMatchObject({ ratingAvg: 0, ratingCount: 0 });
  });

  it('editing only the text, or a hidden review, leaves the average and the cache alone', async () => {
    const a = await buyer('text@example.com');
    const id = (await post(a, { ...GOOD, rating: 4 })).body.data.id;
    await api(app, 'get', `/products/${product.slug}`); // warm the cache
    expect((await patch(a, id, { body: 'Changed my words but not my rating.' })).status).toBe(200);
    expect(redis.store.has(cacheKey())).toBe(true); // nothing to refresh

    await moderate(id, 'hidden');
    expect(await productDoc()).toMatchObject({ ratingAvg: 0, ratingCount: 0 });
    expect((await patch(a, id, { rating: 1 })).status).toBe(200); // owner may still edit
    expect((await Review.findById(id)).status).toBe('hidden'); // but it stays hidden
    expect(await productDoc()).toMatchObject({ ratingAvg: 0, ratingCount: 0 });
  });

  it('eight customers reviewing at the same moment all count (no lost update)', async () => {
    const customers = [];
    for (let i = 0; i < 8; i++) customers.push(await buyer(`race${i}@example.com`));
    const results = await Promise.all(
      customers.map((customer, i) => post(customer, { ...GOOD, rating: (i % 5) + 1 })),
    );
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(201);
    const stored = await productDoc();
    expect(stored.ratingCount).toBe(8);
    expect({ ratingAvg: stored.ratingAvg, ratingCount: stored.ratingCount }).toEqual(await truth());
  }, 60_000);
});

describe('PATCH / DELETE /reviews/:reviewId', () => {
  const DAY = 86_400_000;
  const ageReview = async (id, days) => {
    const review = await Review.findById(id);

    if (!review) {
      throw new Error(`Review ${id} not found`);
    }

    return Review.collection.updateOne(
      { _id: review._id },
      {
        $set: {
          createdAt: new Date(Date.now() - days * DAY),
        },
      },
    );
  };

  it('the owner edits rating, title and body; title: null removes the title', async () => {
    const a = await buyer('edit@example.com');
    const id = (await post(a)).body.data.id;
    const res = await patch(a, id, {
      rating: 3,
      title: null,
      body: 'On reflection it is average.',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      rating: 3,
      title: null,
      body: 'On reflection it is average.',
    });
    expect((await productDoc()).ratingAvg).toBe(3);
  });

  it('an empty patch or an unknown field is 422', async () => {
    const a = await buyer('empty@example.com');
    const id = (await post(a)).body.data.id;
    expect((await patch(a, id, {})).status).toBe(422);
    expect((await patch(a, id, { status: 'hidden' })).status).toBe(422);
    expect((await patch(a, id, { rating: 9 })).status).toBe(422);
  });

  it("another customer's review is 404 for edit and delete, and stays untouched", async () => {
    const a = await buyer('owner@example.com');
    const intruder = await makeCustomerDirect('intruder@example.com');
    const id = (await post(a)).body.data.id;
    expect((await patch(intruder, id, { rating: 1 })).status).toBe(404);
    expect((await remove(intruder, id)).status).toBe(404);
    expect(await Review.findById(id)).toMatchObject({ rating: 5, status: 'published' });
  });

  it('works inside 30 days and is 409 edit_window_closed after', async () => {
    const a = await buyer('window@example.com');
    const id = (await post(a)).body.data.id;

    await ageReview(id, 29);
    expect((await patch(a, id, { rating: 4 })).status).toBe(200);

    await ageReview(id, 31);
    const late = await patch(a, id, { rating: 2 });
    expect(late.status).toBe(409);
    expect(late.body.error).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'edit_window_closed' },
    });
    expect((await remove(a, id)).status).toBe(409);
    expect(await Review.findById(id)).toMatchObject({ rating: 4 }); // unchanged
    expect((await productDoc()).ratingCount).toBe(1);
  });

  it('after deleting, the customer may review the product again', async () => {
    const a = await buyer('again@example.com');
    const id = (await post(a)).body.data.id;
    expect((await remove(a, id)).status).toBe(200);
    expect((await remove(a, id)).status).toBe(404); // already gone
    expect((await post(a, { ...GOOD, rating: 2 })).status).toBe(201);
  });
});

describe('PATCH /admin/reviews/:reviewId/status', () => {
  it('hides and publishes, and audits each real change', async () => {
    const a = await buyer('mod@example.com');
    const id = (await post(a)).body.data.id;

    const hidden = await moderate(id, 'hidden');
    expect(hidden.status, JSON.stringify(hidden.body)).toBe(200);
    expect(hidden.body.data).toMatchObject({ id, status: 'hidden', changed: true });
    const logs = await AuditLog.find({ action: 'review.status_changed', entityId: id });
    expect(logs).toHaveLength(1);
    expect(logs[0].meta).toMatchObject({ from: 'published', to: 'hidden', productId: product.id });
    expect(String(logs[0].actorId)).toBe(admin.id);
  });

  it('repeating the same status changes nothing and writes no second audit entry', async () => {
    const a = await buyer('repeat@example.com');
    const id = (await post(a)).body.data.id;
    await moderate(id, 'hidden');
    const again = await moderate(id, 'hidden');
    expect(again.status).toBe(200);
    expect(again.body.data.changed).toBe(false);
    expect(await AuditLog.countDocuments({ action: 'review.status_changed' })).toBe(1);
  });

  it('unknown review 404, bad status 422, customer 403', async () => {
    const a = await buyer('guard@example.com');
    const id = (await post(a)).body.data.id;
    expect((await moderate('0'.repeat(24), 'hidden')).status).toBe(404);
    expect((await moderate(id, 'deleted')).status).toBe(422);
    expect(
      (await api(app, 'patch', `/admin/reviews/${id}/status`, a.auth, { status: 'hidden' })).status,
    ).toBe(403);
    expect((await Review.findById(id)).status).toBe('published');
  });
});

describe('GET /products/:productId/reviews (public)', () => {
  it('lists only published reviews, newest first, with a short public name and no ids', async () => {
    const a = await buyer('first@example.com');
    const b = await buyer('second@example.com');
    const c = await buyer('third@example.com');
    await User.updateOne({ _id: a.id }, { name: 'Asha Kumar' });
    const ra = (await post(a, { ...GOOD, rating: 5 })).body.data.id;
    await post(b, { ...GOOD, rating: 3, title: undefined });
    const rc = (await post(c, { ...GOOD, rating: 1 })).body.data.id;
    await Review.updateOne(
      { _id: ra },
      { createdAt: new Date(Date.now() - 5000) },
      { timestamps: false },
    );
    await moderate(rc, 'hidden');

    const res = await api(app, 'get', `/products/${product.id}/reviews`); // no token
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 20, total: 2, totalPages: 1 });
    expect(res.body.data.map((r) => r.rating)).toEqual([3, 5]); // newest first, hidden one absent
    const first = res.body.data.find((r) => r.id === ra);
    expect(first).toMatchObject({ authorName: 'Asha K.', verifiedPurchase: true });
    for (const r of res.body.data) {
      expect(Object.keys(r).sort()).toEqual(
        [
          'authorName',
          'body',
          'createdAt',
          'id',
          'rating',
          'title',
          'updatedAt',
          'verifiedPurchase',
        ].sort(),
      );
    }
  });

  it('paginates and sorts by rating', async () => {
    for (let i = 0; i < 3; i++) {
      const customer = await buyer(`page${i}@example.com`);
      await post(customer, { ...GOOD, rating: i + 1 });
    }
    const page1 = await api(app, 'get', `/products/${product.id}/reviews?limit=2&sort=-rating`);
    expect(page1.body.data.map((r) => r.rating)).toEqual([3, 2]);
    expect(page1.body.meta).toMatchObject({ total: 3, totalPages: 2, limit: 2 });
    const page2 = await api(
      app,
      'get',
      `/products/${product.id}/reviews?limit=2&page=2&sort=-rating`,
    );
    expect(page2.body.data.map((r) => r.rating)).toEqual([1]);
    expect((await api(app, 'get', `/products/${product.id}/reviews?sort=bogus`)).status).toBe(422);
    expect((await api(app, 'get', `/products/${product.id}/reviews?limit=500`)).status).toBe(422);
  });

  it('a product that is not on sale, or does not exist, is 404', async () => {
    const draft = await addProduct(app, vendor, await makeCategory(), { status: 'draft' });
    expect((await api(app, 'get', `/products/${draft.id}/reviews`)).status).toBe(404);
    expect((await api(app, 'get', `/products/${'0'.repeat(24)}/reviews`)).status).toBe(404);
    expect((await api(app, 'get', '/products/not-an-id/reviews')).status).toBe(422);
  });
});

describe('GET /products/:productId/reviews/mine', () => {
  it('tells the page whether the customer may review, and returns their own review', async () => {
    const nobody = await makeCustomerDirect('nobody@example.com');
    const none = await api(app, 'get', `/products/${product.id}/reviews/mine`, nobody.auth);
    expect(none.body.data).toEqual({ eligible: false, review: null });

    const a = await buyer('mine@example.com');
    const before = await api(app, 'get', `/products/${product.id}/reviews/mine`, a.auth);
    expect(before.body.data).toEqual({ eligible: true, review: null });

    const id = (await post(a)).body.data.id;
    await moderate(id, 'hidden');
    const after = await api(app, 'get', `/products/${product.id}/reviews/mine`, a.auth);
    expect(after.body.data.eligible).toBe(true);
    expect(after.body.data.review).toMatchObject({ id, status: 'hidden' }); // the author can see it
  });
});
