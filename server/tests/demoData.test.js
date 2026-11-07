import { describe, expect, it } from 'vitest';
import {
  DEMO_CATEGORIES,
  DEMO_COUPON,
  DEMO_PASSWORD,
  DEMO_VENDORS,
} from '../src/scripts/demoData.js';

// The password rule from API_CONTRACTS: 10-72 characters, at least one letter and one digit.
const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{10,72}$/;

describe('demo seed data', () => {
  const categoryKeys = new Set();
  const collect = (nodes) =>
    nodes.forEach((n) => {
      categoryKeys.add(n.key);
      collect(n.children ?? []);
    });
  collect(DEMO_CATEGORIES);

  it('uses a password that satisfies the auth rule', () => {
    expect(DEMO_PASSWORD).toMatch(PASSWORD_RULE);
  });

  it('has integer-paise prices of at least 100 and non-negative integer stock', () => {
    for (const product of DEMO_VENDORS.flatMap((v) => v.products)) {
      expect(Number.isInteger(product.pricePaise)).toBe(true);
      expect(product.pricePaise).toBeGreaterThanOrEqual(100);
      expect(Number.isInteger(product.stockQty)).toBe(true);
      expect(product.stockQty).toBeGreaterThanOrEqual(0);
      expect(product.title.length).toBeGreaterThanOrEqual(3);
      expect(product.title.length).toBeLessThanOrEqual(150);
    }
  });

  it('has unique SKUs per vendor, unique vendor emails, and only known categories', () => {
    expect(new Set(DEMO_VENDORS.map((v) => v.email)).size).toBe(DEMO_VENDORS.length);
    for (const vendor of DEMO_VENDORS) {
      const skus = vendor.products.map((p) => p.sku);
      expect(new Set(skus).size).toBe(skus.length);
      for (const product of vendor.products) expect(categoryKeys.has(product.category)).toBe(true);
    }
  });

  it('keeps categories at most two levels deep', () => {
    for (const top of DEMO_CATEGORIES) {
      for (const child of top.children) expect(child.children ?? []).toEqual([]);
    }
  });

  it('defines a percent coupon with a cap in integer paise', () => {
    expect(DEMO_COUPON.type).toBe('percent');
    expect(Number.isInteger(DEMO_COUPON.maxDiscountPaise)).toBe(true);
  });
});
