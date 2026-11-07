// npm run seed:demo   Fills a running API with demo vendors, categories, products and a coupon.
//
// It talks to the public HTTP API on purpose (D72): the same validation, ownership rules and
// audit entries apply as for real users, and it works against a deployed backend too.
// Safe to run again: it logs in first, and "already exists" answers are skipped.
//
// Needs the admin account to exist first:  npm run seed:admin
// Env: SEED_API_URL (default http://localhost:4000/api/v1), ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD.
import { pathToFileURL } from 'node:url';
import {
  DEMO_CATEGORIES,
  DEMO_COUPON,
  DEMO_CUSTOMER,
  DEMO_PASSWORD,
  DEMO_VENDORS,
} from './demoData.js';

class SeedError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** One API call. Returns `data`; throws SeedError carrying the API's error code and details. */
async function call(baseUrl, path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok || payload?.success !== true) {
    const error = payload?.error ?? {};
    throw new SeedError(`${method} ${path} -> ${res.status} ${error.code ?? ''}`.trim(), {
      status: res.status,
      code: error.code,
      details: error.details,
    });
  }
  return payload.data;
}

const isConflict = (err) => err instanceof SeedError && err.status === 409;

/** Logs in; registers first only when the account does not exist (the register limit is 5/hour). */
async function loginOrRegister(baseUrl, { email, name }, registerPath) {
  try {
    return (
      await call(baseUrl, '/auth/login', {
        method: 'POST',
        body: { email, password: DEMO_PASSWORD },
      })
    ).accessToken;
  } catch (err) {
    if (!(err instanceof SeedError) || err.status !== 401) throw err;
  }
  const session = await call(baseUrl, registerPath, {
    method: 'POST',
    body: { name, email, password: DEMO_PASSWORD },
  });
  return session.accessToken;
}

export async function seedDemo({ baseUrl, adminEmail, adminPassword, log = console.log }) {
  const summary = { categories: 0, vendors: 0, products: 0, coupons: 0 };

  const admin = await call(baseUrl, '/auth/login', {
    method: 'POST',
    body: { email: adminEmail, password: adminPassword },
  });
  const adminToken = admin.accessToken;

  // Categories: reuse what exists (matched by name), create the rest. Two levels at most.
  const existing = new Map();
  const collect = (nodes) =>
    nodes.forEach((n) => {
      existing.set(n.name, n.id);
      collect(n.children ?? []);
    });
  collect(await call(baseUrl, '/categories'));
  const categoryIds = new Map();
  const ensureCategory = async (node, parentId) => {
    let id = existing.get(node.name);
    if (!id) {
      const body = { name: node.name, ...(parentId && { parentId }) };
      id = (await call(baseUrl, '/admin/categories', { method: 'POST', body, token: adminToken }))
        .id;
      summary.categories += 1;
    }
    categoryIds.set(node.key, id);
    for (const child of node.children ?? []) await ensureCategory(child, id);
  };
  for (const top of DEMO_CATEGORIES) await ensureCategory(top);

  for (const vendor of DEMO_VENDORS) {
    const token = await loginOrRegister(baseUrl, vendor, '/auth/register-vendor');
    let shop;
    try {
      shop = await call(baseUrl, '/vendor/profile', {
        method: 'POST',
        body: { shopName: vendor.shopName, description: vendor.description },
        token,
      });
      summary.vendors += 1;
    } catch (err) {
      if (!isConflict(err)) throw err;
      shop = await call(baseUrl, '/vendor/profile', { token });
    }
    if (shop.status !== 'approved') {
      await call(baseUrl, `/admin/vendors/${shop.id}/status`, {
        method: 'PATCH',
        body: { status: 'approved' },
        token: adminToken,
      });
    }
    for (const product of vendor.products) {
      try {
        await call(baseUrl, '/vendor/products', {
          method: 'POST',
          token,
          body: {
            title: product.title,
            description: product.description,
            categoryId: categoryIds.get(product.category),
            pricePaise: product.pricePaise,
            sku: product.sku,
            stockQty: product.stockQty,
            // The key only has to sit under the shop's prefix; no file is uploaded, so the demo
            // product shows a missing image until a real one is uploaded through the vendor UI.
            images: [
              {
                key: `products/${shop.id}/demo-${product.sku.toLowerCase()}.webp`,
                alt: product.title,
              },
            ],
            status: 'active',
          },
        });
        summary.products += 1;
      } catch (err) {
        if (!isConflict(err)) throw err;
      }
    }
    log(`vendor ready: ${vendor.shopName}`);
  }

  const now = Date.now();
  try {
    await call(baseUrl, '/admin/coupons', {
      method: 'POST',
      token: adminToken,
      body: {
        ...DEMO_COUPON,
        startsAt: new Date(now - 86_400_000).toISOString(),
        expiresAt: new Date(now + 365 * 86_400_000).toISOString(),
      },
    });
    summary.coupons += 1;
  } catch (err) {
    if (!isConflict(err)) throw err;
  }

  await loginOrRegister(baseUrl, DEMO_CUSTOMER, '/auth/register');
  return summary;
}

// CLI entry. Prints the API's validation details on failure: if a request shape differs from
// API_CONTRACTS, the message says which field, and only that one request needs changing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseUrl = (process.env.SEED_API_URL ?? 'http://localhost:4000/api/v1').replace(/\/$/, '');
  const adminEmail = process.env.ADMIN_SEED_EMAIL;
  const adminPassword = process.env.ADMIN_SEED_PASSWORD;
  if (!adminEmail || !adminPassword) {
    console.error(
      'Set ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD (the admin from `npm run seed:admin`)',
    );
    process.exit(1);
  }
  try {
    const summary = await seedDemo({ baseUrl, adminEmail, adminPassword });
    console.log('Seed finished:', JSON.stringify(summary));
    console.log(`Demo logins use the password in demoData.js; customer: ${DEMO_CUSTOMER.email}`);
  } catch (err) {
    console.error(err.message);
    if (err.details) console.error(JSON.stringify(err.details));
    process.exit(1);
  }
}
