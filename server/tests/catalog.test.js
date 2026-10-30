import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Category } from '../src/modules/catalog/categories.model.js';
import { Product } from '../src/modules/catalog/products.model.js';
import { Vendor } from '../src/modules/shops/shops.model.js';
import { clearDb, startTestDb, stopTestDb } from './db.js';
import { makeAdmin, makeCategory, makeVendor, productBody, signUp } from './factories.js';
import { buildTestApp } from './helpers.js';

let replSet;
let app;
beforeAll(async () => {
  replSet = await startTestDb();
}, 60_000);
afterAll(() => stopTestDb(replSet));
beforeEach(async () => {
  await clearDb();
  app = buildTestApp();
});

const api = (method, path, auth, body) => {
  const agent = request(app);
  const req = agent[method](`/api/v1${path}`).set(auth ?? {});
  return body === undefined ? req : req.send(body);
};

describe('categories', () => {
  it('admin creates top-level and child categories; the public tree shows active ones', async () => {
    const admin = await makeAdmin(app);
    const root = await api('post', '/admin/categories', admin.auth, {
      name: 'Clothing',
      sortOrder: 1,
    });
    expect(root.status).toBe(201);
    expect(root.body.data).toMatchObject({ slug: 'clothing', parentId: null, isActive: true });

    const child = await api('post', '/admin/categories', admin.auth, {
      name: 'Kurtas',
      parentId: root.body.data.id,
      defaultCommissionBps: 800,
    });
    expect(child.status).toBe(201);
    await api('post', '/admin/categories', admin.auth, { name: 'Hidden', isActive: false });

    const tree = await api('get', '/categories');
    expect(tree.status).toBe(200);
    expect(tree.body.data).toEqual([
      {
        id: root.body.data.id,
        name: 'Clothing',
        slug: 'clothing',
        children: [{ id: child.body.data.id, name: 'Kurtas', slug: 'kurtas' }],
      },
    ]);

    const all = await api('get', '/admin/categories', admin.auth);
    expect(all.body.data).toHaveLength(3); // admin sees the inactive one too
  });

  it('enforces max depth 2, unique slugs and valid commission', async () => {
    const admin = await makeAdmin(app);
    const root = (await api('post', '/admin/categories', admin.auth, { name: 'Home' })).body.data;
    const child = (
      await api('post', '/admin/categories', admin.auth, { name: 'Decor', parentId: root.id })
    ).body.data;

    const tooDeep = await api('post', '/admin/categories', admin.auth, {
      name: 'Lamps',
      parentId: child.id,
    });
    expect(tooDeep.status).toBe(422);
    expect(tooDeep.body.error.details[0].path).toBe('body.parentId');

    expect((await api('post', '/admin/categories', admin.auth, { name: 'Home' })).status).toBe(409);
    expect(
      (
        await api('post', '/admin/categories', admin.auth, {
          name: 'Bad',
          defaultCommissionBps: 6000,
        })
      ).status,
    ).toBe(422);
    const orphan = await api('post', '/admin/categories', admin.auth, {
      name: 'Orphan',
      parentId: '0'.repeat(24),
    });
    expect(orphan.status).toBe(422);
  });

  it('PATCH updates fields, blocks self-parenting and nesting a category that has children', async () => {
    const admin = await makeAdmin(app);
    const a = (await api('post', '/admin/categories', admin.auth, { name: 'Alpha' })).body.data;
    const b = (await api('post', '/admin/categories', admin.auth, { name: 'Beta', parentId: a.id }))
      .body.data;

    const renamed = await api('patch', `/admin/categories/${a.id}`, admin.auth, {
      name: 'Alpha 2',
      isActive: false,
    });
    expect(renamed.body.data).toMatchObject({ name: 'Alpha 2', isActive: false, slug: 'alpha' });
    expect(
      (await api('patch', `/admin/categories/${a.id}`, admin.auth, { parentId: a.id })).status,
    ).toBe(422);

    const other = (await api('post', '/admin/categories', admin.auth, { name: 'Gamma' })).body.data;
    // Alpha has a child (Beta), so it cannot itself become a child of Gamma
    expect(
      (await api('patch', `/admin/categories/${a.id}`, admin.auth, { parentId: other.id })).status,
    ).toBe(422);
    // un-nesting works
    expect(
      (await api('patch', `/admin/categories/${b.id}`, admin.auth, { parentId: null })).body.data
        .parentId,
    ).toBeNull();
    expect(
      (await api('patch', `/admin/categories/${'0'.repeat(24)}`, admin.auth, { name: 'Zed' }))
        .status,
    ).toBe(404);
    expect((await api('patch', `/admin/categories/${a.id}`, admin.auth, {})).status).toBe(422);
  });

  it('admin routes are admin-only', async () => {
    const vendor = await makeVendor(app, 'v@example.com');
    const customer = await signUp(app, 'c@example.com');
    for (const who of [vendor, customer]) {
      expect((await api('post', '/admin/categories', who.auth, { name: 'Nope' })).status).toBe(403);
      expect((await api('get', '/admin/categories', who.auth)).status).toBe(403);
    }
    expect((await api('get', '/admin/categories')).status).toBe(401);
  });
});

describe('vendor products: create and validate', () => {
  it('creates a draft with a slug, image URLs and an owner-scoped vendorId', async () => {
    const vendor = await makeVendor(app, 'v@example.com');
    const category = await makeCategory();
    const res = await api(
      'post',
      '/vendor/products',
      vendor.auth,
      productBody(vendor.shop.id, category.id),
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      title: 'Handloom Cotton Kurta',
      status: 'draft',
      pricePaise: 149900,
      stockQty: 25,
      vendorId: vendor.shop.id,
      ratingCount: 0,
    });
    expect(res.body.data.slug).toMatch(/^handloom-cotton-kurta-[a-z0-9]{4}$/);
    expect(res.body.data.images[0].url).toBe(`https://cdn.test/${res.body.data.images[0].key}`);
    expect(res.body.data._id).toBeUndefined();
  });

  it('ignores any vendorId the client sends (strict body -> 422)', async () => {
    const a = await makeVendor(app, 'a@example.com', { shopName: 'Shop A' });
    const b = await makeVendor(app, 'b@example.com', { shopName: 'Shop B' });
    const category = await makeCategory();
    const res = await api('post', '/vendor/products', a.auth, {
      ...productBody(a.shop.id, category.id),
      vendorId: b.shop.id,
    });
    expect(res.status).toBe(422);
    expect(await Product.countDocuments()).toBe(0);
  });

  // Acceptance: "Negative stock or non-integer price returns 422"
  it.each([
    ['negative stock', { stockQty: -1 }],
    ['fractional stock', { stockQty: 1.5 }],
    ['fractional price', { pricePaise: 99.5 }],
    ['price below 100 paise', { pricePaise: 99 }],
    ['price as a string', { pricePaise: '149900' }],
    ['compare-at not above price', { compareAtPricePaise: 149900 }],
    ['no images', { images: [] }],
    [
      'seven images',
      { images: Array.from({ length: 7 }, (_, i) => ({ key: `products/x/${i}.png` })) },
    ],
    [
      'too many attributes',
      { attributes: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 'v'])) },
    ],
    ['short title', { title: 'ab' }],
    ['unknown status', { status: 'suspended' }],
    ['malformed category id', { categoryId: 'nope' }],
  ])('rejects: %s', async (_label, overrides) => {
    const vendor = await makeVendor(app, 'v@example.com');
    const category = await makeCategory();
    const res = await api(
      'post',
      '/vendor/products',
      vendor.auth,
      productBody(vendor.shop.id, category.id, overrides),
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // Acceptance: "a product with an image key outside the vendor's prefix returns 422"
  it('rejects image keys outside the vendor prefix or with a bad shape', async () => {
    const a = await makeVendor(app, 'a@example.com', { shopName: 'Shop A' });
    const b = await makeVendor(app, 'b@example.com', { shopName: 'Shop B' });
    const category = await makeCategory();
    for (const key of [
      `products/${b.shop.id}/9f2a1c3e.webp`, // another vendor's prefix
      `products/${a.shop.id}/../${b.shop.id}/x.webp`, // traversal attempt
      `logos/${a.shop.id}/9f2a1c3e.webp`, // wrong folder
      `products/${a.shop.id}/script.exe`, // wrong extension
    ]) {
      const res = await api(
        'post',
        '/vendor/products',
        a.auth,
        productBody(a.shop.id, category.id, { images: [{ key }] }),
      );
      expect(res.status, key).toBe(422);
      expect(res.body.error.details[0].path).toBe('body.images.0.key');
    }
  });

  it('requires an existing, active category', async () => {
    const vendor = await makeVendor(app, 'v@example.com');
    const inactive = await makeCategory({ isActive: false });
    for (const categoryId of [inactive.id, '0'.repeat(24)]) {
      const res = await api(
        'post',
        '/vendor/products',
        vendor.auth,
        productBody(vendor.shop.id, categoryId),
      );
      expect(res.status).toBe(422);
      expect(res.body.error.details[0].path).toBe('body.categoryId');
    }
  });

  it('SKU is unique per vendor, not globally', async () => {
    const a = await makeVendor(app, 'a@example.com', { shopName: 'Shop A' });
    const b = await makeVendor(app, 'b@example.com', { shopName: 'Shop B' });
    const category = await makeCategory();
    expect(
      (await api('post', '/vendor/products', a.auth, productBody(a.shop.id, category.id))).status,
    ).toBe(201);
    expect(
      (await api('post', '/vendor/products', a.auth, productBody(a.shop.id, category.id))).status,
    ).toBe(409);
    expect(
      (await api('post', '/vendor/products', b.auth, productBody(b.shop.id, category.id))).status,
    ).toBe(201);
  });

  it('a vendor without a shop gets 403 on product routes', async () => {
    const noShop = await signUp(app, 'v@example.com', 'register-vendor');
    expect((await api('get', '/vendor/products', noShop.auth)).status).toBe(403);
    expect((await api('post', '/vendor/products', noShop.auth, {})).status).toBe(403);
  });
});

describe('vendor products: publishing rules', () => {
  // Acceptance: "Unapproved vendor cannot set a product active (403 VENDOR_NOT_APPROVED)"
  it('unapproved vendor cannot create or switch a product to active', async () => {
    const vendor = await makeVendor(app, 'v@example.com'); // pending
    const category = await makeCategory();

    const direct = await api(
      'post',
      '/vendor/products',
      vendor.auth,
      productBody(vendor.shop.id, category.id, { status: 'active' }),
    );
    expect(direct.status).toBe(403);
    expect(direct.body.error.code).toBe('VENDOR_NOT_APPROVED');

    const draft = await api(
      'post',
      '/vendor/products',
      vendor.auth,
      productBody(vendor.shop.id, category.id),
    );
    expect(draft.status).toBe(201); // drafts are fine
    const publish = await api('patch', `/vendor/products/${draft.body.data.id}`, vendor.auth, {
      status: 'active',
    });
    expect(publish.status).toBe(403);
    expect(publish.body.error.code).toBe('VENDOR_NOT_APPROVED');
    expect((await Product.findById(draft.body.data.id)).status).toBe('draft');
  });

  it('suspended and rejected shops cannot publish either', async () => {
    const vendor = await makeVendor(app, 'v@example.com', { approved: true });
    const category = await makeCategory();
    const draft = (
      await api('post', '/vendor/products', vendor.auth, productBody(vendor.shop.id, category.id))
    ).body.data;
    for (const status of ['suspended', 'rejected']) {
      await Vendor.updateOne({ _id: vendor.shop.id }, { status });
      const res = await api('patch', `/vendor/products/${draft.id}`, vendor.auth, {
        status: 'active',
      });
      expect(res.status, status).toBe(403);
    }
  });

  it('approved vendor publishes; edits fields; cannot touch stock via PATCH', async () => {
    const vendor = await makeVendor(app, 'v@example.com', { approved: true });
    const category = await makeCategory();
    const created = await api(
      'post',
      '/vendor/products',
      vendor.auth,
      productBody(vendor.shop.id, category.id, { status: 'active' }),
    );
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('active');
    const url = `/vendor/products/${created.body.data.id}`;

    const patched = await api('patch', url, vendor.auth, {
      title: 'Updated Kurta',
      pricePaise: 129900,
      compareAtPricePaise: 199900,
      attributes: { color: 'indigo', size: 'M' },
      description: null,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({
      title: 'Updated Kurta',
      pricePaise: 129900,
      compareAtPricePaise: 199900,
      attributes: { color: 'indigo', size: 'M' },
      slug: created.body.data.slug, // slug stays stable
    });
    expect(patched.body.data.description).toBeUndefined();

    expect((await api('patch', url, vendor.auth, { stockQty: 5 })).status).toBe(422);
    expect((await api('patch', url, vendor.auth, { compareAtPricePaise: 100000 })).status).toBe(
      422,
    ); // <= price
    expect((await api('patch', url, vendor.auth, { pricePaise: 250000 })).status).toBe(422); // now >= compare-at
    expect(
      (await api('patch', url, vendor.auth, { compareAtPricePaise: null })).body.data
        .compareAtPricePaise,
    ).toBeUndefined();
    expect((await api('patch', url, vendor.auth, {})).status).toBe(422);
  });

  it('DELETE archives (idempotent) and lists support status filter + pagination', async () => {
    const vendor = await makeVendor(app, 'v@example.com', { approved: true });
    const category = await makeCategory();
    const ids = [];
    for (let i = 1; i <= 3; i++) {
      const res = await api(
        'post',
        '/vendor/products',
        vendor.auth,
        productBody(vendor.shop.id, category.id, { sku: `SKU-${i}`, title: `Product ${i}` }),
      );
      ids.push(res.body.data.id);
    }
    const first = await api('delete', `/vendor/products/${ids[0]}`, vendor.auth);
    expect(first.body.data.status).toBe('archived');
    expect((await api('delete', `/vendor/products/${ids[0]}`, vendor.auth)).body.data.status).toBe(
      'archived',
    );
    expect(await Product.countDocuments()).toBe(3); // archived, not removed

    const page = await api('get', '/vendor/products?limit=2&page=2', vendor.auth);
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
    const archived = await api('get', '/vendor/products?status=archived', vendor.auth);
    expect(archived.body.data.map((p) => p.id)).toEqual([ids[0]]);
    expect((await api('get', '/vendor/products?limit=500', vendor.auth)).status).toBe(422);
  });

  it('a suspended product cannot be restored or archived by the vendor', async () => {
    const vendor = await makeVendor(app, 'v@example.com', { approved: true });
    const category = await makeCategory();
    const p = (
      await api(
        'post',
        '/vendor/products',
        vendor.auth,
        productBody(vendor.shop.id, category.id, { status: 'active' }),
      )
    ).body.data;
    await Product.updateOne({ _id: p.id }, { status: 'suspended' });
    const patch = await api('patch', `/vendor/products/${p.id}`, vendor.auth, { status: 'active' });
    expect(patch.status).toBe(409);
    expect(patch.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect((await api('delete', `/vendor/products/${p.id}`, vendor.auth)).status).toBe(409);
    // other fields remain editable
    expect(
      (await api('patch', `/vendor/products/${p.id}`, vendor.auth, { title: 'Still editable' }))
        .status,
    ).toBe(200);
  });
});

describe('stock updates', () => {
  it('sets stock absolutely; rejects negative, fractional and oversized values', async () => {
    const vendor = await makeVendor(app, 'v@example.com');
    const category = await makeCategory();
    const p = (
      await api('post', '/vendor/products', vendor.auth, productBody(vendor.shop.id, category.id))
    ).body.data;
    const url = `/vendor/products/${p.id}/stock`;

    expect((await api('patch', url, vendor.auth, { stockQty: 0 })).body.data.stockQty).toBe(0);
    expect((await api('patch', url, vendor.auth, { stockQty: 40 })).body.data.stockQty).toBe(40);
    for (const stockQty of [-1, 2.5, '5', 1_000_001]) {
      expect((await api('patch', url, vendor.auth, { stockQty })).status).toBe(422);
    }
    expect((await api('patch', url, vendor.auth, { stockQty: 5, extra: 1 })).status).toBe(422);
    expect((await Product.findById(p.id)).stockQty).toBe(40);
  });
});

// Acceptance: "Vendor A requesting/editing Vendor B's product by ID gets 404 for GET, PATCH, DELETE and stock (4 tests)"
describe('cross-vendor isolation (404, not 403)', () => {
  let a;
  let b;
  let productOfB;
  beforeEach(async () => {
    a = await makeVendor(app, 'a@example.com', { approved: true, shopName: 'Shop A' });
    b = await makeVendor(app, 'b@example.com', { approved: true, shopName: 'Shop B' });
    const category = await makeCategory();
    productOfB = (
      await api('post', '/vendor/products', b.auth, productBody(b.shop.id, category.id))
    ).body.data;
  });

  it('GET -> 404', async () => {
    const res = await api('get', `/vendor/products/${productOfB.id}`, a.auth);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('PATCH -> 404 and nothing changes', async () => {
    const res = await api('patch', `/vendor/products/${productOfB.id}`, a.auth, {
      title: 'Hijacked title',
    });
    expect(res.status).toBe(404);
    expect((await Product.findById(productOfB.id)).title).toBe('Handloom Cotton Kurta');
  });

  it('DELETE -> 404 and the product stays draft', async () => {
    const res = await api('delete', `/vendor/products/${productOfB.id}`, a.auth);
    expect(res.status).toBe(404);
    expect((await Product.findById(productOfB.id)).status).toBe('draft');
  });

  it('PATCH stock -> 404 and stock is unchanged', async () => {
    const res = await api('patch', `/vendor/products/${productOfB.id}/stock`, a.auth, {
      stockQty: 0,
    });
    expect(res.status).toBe(404);
    expect((await Product.findById(productOfB.id)).stockQty).toBe(25);
  });

  it("A's list never contains B's products; unknown ids are also 404", async () => {
    const list = await api('get', '/vendor/products', a.auth);
    expect(list.body.data).toEqual([]);
    expect((await api('get', `/vendor/products/${'0'.repeat(24)}`, a.auth)).status).toBe(404);
    expect((await api('get', '/vendor/products/not-an-id', a.auth)).status).toBe(422);
  });

  it("A cannot reuse B's image keys on their own product", async () => {
    const category = await makeCategory();
    const res = await api(
      'post',
      '/vendor/products',
      a.auth,
      productBody(a.shop.id, category.id, { images: [{ key: productOfB.images[0].key }] }),
    );
    expect(res.status).toBe(422);
  });
});

describe('public product page', () => {
  async function setup({ status = 'active', vendorApproved = true } = {}) {
    const vendor = await makeVendor(app, 'v@example.com', { approved: vendorApproved });
    const category = await makeCategory();
    const created = await api(
      'post',
      '/vendor/products',
      vendor.auth,
      productBody(vendor.shop.id, category.id, { attributes: { color: 'indigo' } }),
    );
    await Product.updateOne({ _id: created.body.data.id }, { status });
    return { vendor, slug: created.body.data.slug };
  }

  it('returns an active product of an approved shop, with only public fields', async () => {
    const { slug } = await setup();
    const res = await api('get', `/products/${slug}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      slug,
      title: 'Handloom Cotton Kurta',
      pricePaise: 149900,
      inStock: true,
      attributes: { color: 'indigo' },
      shop: { name: 'Loom and Co', slug: 'loom-and-co' },
    });
    expect(res.body.data.images[0].url).toMatch(/^https:\/\/cdn\.test\/products\//);
    for (const secret of ['stockQty', 'sku', 'vendorId', 'status', 'soldCount', '_id']) {
      expect(res.body.data, secret).not.toHaveProperty(secret);
    }
  });

  it.each(['draft', 'archived', 'suspended'])(
    'never returns a %s product (404)',
    async (status) => {
      const { slug } = await setup({ status });
      expect((await api('get', `/products/${slug}`)).status).toBe(404);
    },
  );

  it('never returns a product of a shop that is not approved (404)', async () => {
    const { slug, vendor } = await setup();
    for (const status of ['pending', 'rejected', 'suspended']) {
      await Vendor.updateOne({ _id: vendor.shop.id }, { status });
      expect((await api('get', `/products/${slug}`)).status, status).toBe(404);
    }
  });

  it('reports inStock=false at zero stock and 404 for unknown or malformed slugs', async () => {
    const { slug, vendor } = await setup();
    await Product.updateOne({ slug }, { stockQty: 0 });
    expect((await api('get', `/products/${slug}`)).body.data.inStock).toBe(false);
    expect((await api('get', '/products/does-not-exist')).status).toBe(404);
    expect((await api('get', '/products/Bad_Slug!')).status).toBe(422);
    expect(vendor.shop.id).toBeTruthy();
  });
});

describe('Category model sanity', () => {
  it('keeps slugs unique at the database level', async () => {
    await Category.create({ name: 'One', slug: 'same' });
    await expect(Category.create({ name: 'Two', slug: 'same' })).rejects.toMatchObject({
      code: 11000,
    });
  });
});
