import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { publicName, ratingSummary } from '../src/lib/ratings.js';
import {
  buildInvoiceView,
  formatPaise,
  invoiceNumberFor,
  pdfSafe,
} from '../src/modules/invoices/invoices.view.js';
import {
  createReviewBody,
  listReviewsQuery,
  updateReviewBody,
} from '../src/modules/reviews/reviews.validator.js';

const RUNS = { numRuns: 500 };

describe('ratingSummary', () => {
  it('no reviews -> 0 / 0', () => {
    expect(ratingSummary(0, 0)).toEqual({ ratingAvg: 0, ratingCount: 0 });
  });

  it.each([
    [5, 1, 5],
    [9, 2, 4.5],
    [11, 3, 3.67],
    [7, 3, 2.33],
    [4, 3, 1.33],
  ])('sum %i over %i reviews -> %f', (sum, count, avg) => {
    expect(ratingSummary(sum, count)).toEqual({ ratingAvg: avg, ratingCount: count });
  });

  it('property: the average of 1-5 star ratings stays within 1-5 and within 0.005 of the true mean', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 300 }),
        (ratings) => {
          const sum = ratings.reduce((a, b) => a + b, 0);
          const { ratingAvg, ratingCount } = ratingSummary(sum, ratings.length);
          expect(ratingCount).toBe(ratings.length);
          expect(ratingAvg).toBeGreaterThanOrEqual(1);
          expect(ratingAvg).toBeLessThanOrEqual(5);
          expect(Math.abs(ratingAvg - sum / ratings.length)).toBeLessThanOrEqual(0.005 + 1e-9);
        },
      ),
      RUNS,
    );
  });

  it('rejects negative, fractional and unsafe inputs', () => {
    expect(() => ratingSummary(-1, 1)).toThrow(RangeError);
    expect(() => ratingSummary(1.5, 1)).toThrow(RangeError);
    expect(() => ratingSummary(1, -1)).toThrow(RangeError);
  });
});

describe('publicName', () => {
  it.each([
    ['Asha Kumar', 'Asha K.'],
    ['  asha   kumar nair ', 'asha N.'],
    ['Prince', 'Prince'],
    ['', 'Customer'],
    [undefined, 'Customer'],
  ])('%j -> %s', (name, shown) => {
    expect(publicName(name)).toBe(shown);
  });
});

describe('formatPaise', () => {
  it.each([
    [0, 'INR 0.00'],
    [5, 'INR 0.05'],
    [100, 'INR 1.00'],
    [149950, 'INR 1,499.50'],
    [100000000, 'INR 10,00,000.00'],
    [-50000, '-INR 500.00'],
  ])('%i -> %s', (paise, text) => {
    expect(formatPaise(paise)).toBe(text);
  });

  it('property: digits read back as exactly the same paise (no float drift)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9_000_000_000_000 }), (paise) => {
        const digits = formatPaise(paise).replace(/[^0-9]/g, '');
        expect(Number(digits)).toBe(paise);
      }),
      RUNS,
    );
  });

  it('refuses a non-integer', () => {
    expect(() => formatPaise(10.5)).toThrow(RangeError);
  });
});

describe('pdfSafe and invoiceNumberFor', () => {
  it('keeps Latin-1, replaces everything else, flattens line breaks', () => {
    expect(pdfSafe('Caf\u00e9 Kurta')).toBe('Caf\u00e9 Kurta');
    expect(pdfSafe('Kurta\n\tRed')).toBe('Kurta Red');
    expect(pdfSafe('\u0928\u092e\u0938\u094d\u0924\u0947')).toBe('??????');
    expect(pdfSafe(null)).toBe('');
  });

  it('formats INV-YYYY-NNNNNN', () => {
    expect(invoiceNumberFor(2026, 1)).toBe('INV-2026-000001');
    expect(invoiceNumberFor(2026, 123456)).toBe('INV-2026-123456');
    expect(invoiceNumberFor(2027, 1234567)).toBe('INV-2027-1234567'); // never truncated
  });
});

describe('buildInvoiceView', () => {
  const item = (title, unit, qty, discount = 0) => ({
    title,
    sku: `SKU-${title}`,
    quantity: qty,
    unitPricePaise: unit,
    discountPaise: discount,
    lineNetPaise: unit * qty - discount,
  });
  const sub = (vendorId, n, items, refundedPaise = 0, fulfillmentStatus = 'delivered') => {
    const subtotal = items.reduce((s, i) => s + i.unitPricePaise * i.quantity, 0);
    const discount = items.reduce((s, i) => s + i.discountPaise, 0);
    return {
      vendorId,
      subOrderNumber: `MP-1-V${n}`,
      fulfillmentStatus,
      items,
      subtotalPaise: subtotal,
      discountPaise: discount,
      shippingPaise: 0,
      customerTotalPaise: subtotal - discount,
      refundedPaise,
    };
  };
  const order = {
    orderNumber: 'MP-1',
    currency: 'INR',
    placedAt: new Date('2026-03-01T10:00:00Z'),
    shippingAddress: {
      name: 'Asha K',
      line1: '12 Lake Rd',
      line2: 'Flat 4',
      city: 'Kochi',
      state: 'Kerala',
      postalCode: '682001',
      phone: '+919876543210',
    },
    subtotalPaise: 70000,
    discountPaise: 7000,
    shippingPaise: 0,
    totalPaise: 63000,
    coupon: { code: 'SAVE10', discountPaise: 7000 },
  };
  const subs = [
    sub('v1', 1, [item('Kurta', 20000, 2, 4000)], 1000),
    sub('v2', 2, [item('Scarf', 30000, 1, 3000)], 0, 'shipped'),
  ];
  const shopsById = new Map([
    ['v1', { shopName: 'Loom & Co' }],
    ['v2', { shopName: 'Silk Lane' }],
  ]);
  const invoice = {
    invoiceNumber: 'INV-2026-000007',
    generatedAt: new Date('2026-03-02T00:00:00Z'),
  };

  it('lists every vendor and item and reproduces the order totals', () => {
    const view = buildInvoiceView({ order, subOrders: subs, shopsById, invoice });
    expect(view.sections.map((s) => s.shopName)).toEqual(['Loom & Co', 'Silk Lane']);
    expect(view.sections.map((s) => s.items[0].title)).toEqual(['Kurta', 'Scarf']);
    expect(view.sections[1].status).toBe('shipped');
    expect(view.totals).toEqual({
      subtotalPaise: 70000,
      discountPaise: 7000,
      shippingPaise: 0,
      totalPaise: 63000,
      refundedPaise: 1000,
      netPaidPaise: 62000,
    });
    expect(view.coupon).toEqual({ code: 'SAVE10', discountPaise: 7000 });
    expect(view.invoiceNumber).toBe('INV-2026-000007');
    expect(view.billTo).toEqual([
      'Asha K',
      '12 Lake Rd, Flat 4',
      'Kochi, Kerala 682001',
      '+919876543210',
    ]);
    expect(view.sections.reduce((s, x) => s + x.customerTotalPaise, 0)).toBe(order.totalPaise);
  });

  it('copes with a missing shop and no coupon', () => {
    const view = buildInvoiceView({
      order: { ...order, coupon: null },
      subOrders: [subs[0]],
      shopsById: new Map(),
      invoice,
    });
    expect(view.sections[0].shopName).toBe('Seller');
    expect(view.coupon).toBeNull();
  });
});

describe('review validators', () => {
  it('create: rating 1-5 integer, body 10-2000 chars, strict keys, title optional', () => {
    expect(createReviewBody.safeParse({ rating: 5, body: 'Long enough text.' }).success).toBe(true);
    expect(createReviewBody.safeParse({ rating: 0, body: 'Long enough text.' }).success).toBe(
      false,
    );
    expect(createReviewBody.safeParse({ rating: 3, body: 'short' }).success).toBe(false);
    expect(createReviewBody.safeParse({ rating: 3, body: 'Long enough text.', x: 1 }).success).toBe(
      false,
    );
  });

  it('create trims text; a body of only spaces is refused', () => {
    const parsed = createReviewBody.parse({
      rating: 3,
      title: '  Nice  ',
      body: '  Long enough text.  ',
    });
    expect(parsed).toMatchObject({ title: 'Nice', body: 'Long enough text.' });
    expect(createReviewBody.safeParse({ rating: 3, body: ' '.repeat(20) }).success).toBe(false);
  });

  it('update: at least one field; title may be null', () => {
    expect(updateReviewBody.safeParse({}).success).toBe(false);
    expect(updateReviewBody.safeParse({ title: null }).success).toBe(true);
    expect(updateReviewBody.safeParse({ rating: 2 }).success).toBe(true);
  });

  it('list: defaults and allowed sorts', () => {
    expect(listReviewsQuery.parse({})).toEqual({ page: 1, limit: 20, sort: '-createdAt' });
    expect(listReviewsQuery.safeParse({ sort: 'price' }).success).toBe(false);
  });
});
