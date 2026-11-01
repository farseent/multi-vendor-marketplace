import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocateProportionally, mulDivRoundHalfUp } from '../src/lib/money.js';
import { couponRuleDetails, evaluateCoupon } from '../src/modules/coupons/coupons.rules.js';

// No database: money maths and coupon rules are pure functions.

describe('mulDivRoundHalfUp', () => {
  it.each([
    [12345, 10, 100, 1235], // 1234.5 rounds up
    [12344, 10, 100, 1234], // 1234.4 rounds down
    [1, 1, 2, 1], // 0.5 -> 1
    [0, 5, 3, 0],
    [999, 90, 100, 899], // 899.1
  ])('%i * %i / %i = %i', (a, b, c, expected) => {
    expect(mulDivRoundHalfUp(a, b, c)).toBe(expected);
  });

  it('is exact for amounts where float maths would drift', () => {
    expect(mulDivRoundHalfUp(Number.MAX_SAFE_INTEGER, 1, 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(mulDivRoundHalfUp(9_007_199_254_740_991, 90, 100)).toBe(8_106_479_329_266_892);
  });

  it('rejects negatives, fractions and division by zero', () => {
    expect(() => mulDivRoundHalfUp(-1, 1, 1)).toThrow(RangeError);
    expect(() => mulDivRoundHalfUp(1.5, 1, 1)).toThrow(RangeError);
    expect(() => mulDivRoundHalfUp(1, 1, 0)).toThrow(RangeError);
  });
});

describe('allocateProportionally (largest remainder)', () => {
  it('splits 100 over [1,1,1] as 34/33/33 (extra paisa to the earliest tie)', () => {
    expect(allocateProportionally(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });

  it('gives the leftover to the biggest fractional parts', () => {
    // exact shares: 3.33.., 6.66..  -> floors 3, 6, one leftover goes to the 6.66 share
    expect(allocateProportionally(10, [1, 2])).toEqual([3, 7]);
  });

  it('handles zero weights and a zero total', () => {
    expect(allocateProportionally(0, [5, 0, 3])).toEqual([0, 0, 0]);
    expect(allocateProportionally(7, [0, 7])).toEqual([0, 7]);
    expect(allocateProportionally(0, [])).toEqual([]);
  });

  it('rejects impossible requests', () => {
    expect(() => allocateProportionally(5, [])).toThrow(RangeError);
    expect(() => allocateProportionally(5, [0, 0])).toThrow(RangeError);
    expect(() => allocateProportionally(-1, [1])).toThrow(RangeError);
  });

  it('property: shares sum exactly to the total and never exceed their weight', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5_000_000 }), { minLength: 1, maxLength: 12 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (weights, fraction) => {
          const sum = weights.reduce((a, b) => a + b, 0);
          fc.pre(sum > 0);
          const total = Math.floor(sum * fraction); // total <= sum(weights)
          const shares = allocateProportionally(total, weights);
          expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
          shares.forEach((share, i) => expect(share).toBeLessThanOrEqual(weights[i]));
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('couponRuleDetails', () => {
  const base = {
    type: 'percent',
    value: 10,
    startsAt: new Date('2026-01-01'),
    expiresAt: new Date('2026-02-01'),
  };

  it('accepts valid combinations', () => {
    expect(couponRuleDetails(base)).toEqual([]);
    expect(couponRuleDetails({ ...base, type: 'fixed', value: 100 })).toEqual([]);
    expect(couponRuleDetails({ ...base, value: 90, maxDiscountPaise: 5000 })).toEqual([]);
  });

  it.each([
    ['percent above 90', { value: 91 }, 'body.value'],
    ['percent of 0', { value: 0 }, 'body.value'],
    ['fixed below 100 paise', { type: 'fixed', value: 99 }, 'body.value'],
    [
      'cap on a fixed coupon',
      { type: 'fixed', value: 500, maxDiscountPaise: 100 },
      'body.maxDiscountPaise',
    ],
    ['expiry not after start', { expiresAt: new Date('2026-01-01') }, 'body.expiresAt'],
  ])('rejects %s', (_name, patch, path) => {
    expect(couponRuleDetails({ ...base, ...patch }).map((d) => d.path)).toContain(path);
  });
});

// ---- Coupon validation: the 10 cases from IMPLEMENTATION_PLAN Phase 4, table-driven ----

const NOW = new Date('2026-06-15T12:00:00Z');
const coupon = (overrides = {}) => ({
  code: 'SAVE10',
  scope: 'platform',
  vendorId: undefined,
  type: 'percent',
  value: 10,
  minOrderPaise: 0,
  maxDiscountPaise: undefined,
  startsAt: new Date('2026-06-01T00:00:00Z'),
  expiresAt: new Date('2026-07-01T00:00:00Z'),
  usageLimitTotal: undefined,
  usageLimitPerUser: 1,
  usedCount: 0,
  status: 'active',
  ...overrides,
});
// Two vendors: A = ...a, B = ...b.
const A = 'a'.repeat(24);
const B = 'b'.repeat(24);
const lines = [
  { vendorId: A, lineSubtotalPaise: 60000 },
  { vendorId: B, lineSubtotalPaise: 40000 },
];

describe('evaluateCoupon: table of cases', () => {
  const cases = [
    ['expired', coupon({ expiresAt: new Date('2026-06-10T00:00:00Z') }), {}, { reason: 'expired' }],
    ['expires exactly now', coupon({ expiresAt: NOW }), {}, { reason: 'expired' }],
    [
      'not started',
      coupon({ startsAt: new Date('2026-06-16T00:00:00Z') }),
      {},
      { reason: 'not_started' },
    ],
    ['disabled', coupon({ status: 'disabled' }), {}, { reason: 'disabled' }],
    ['below minimum order', coupon({ minOrderPaise: 100001 }), {}, { reason: 'below_min_order' }],
    [
      'over the total limit',
      coupon({ usageLimitTotal: 5, usedCount: 5 }),
      {},
      { reason: 'total_limit_reached' },
    ],
    [
      'over the per-user limit',
      coupon({ usageLimitPerUser: 2 }),
      { usesByCustomer: 2 },
      { reason: 'user_limit_reached' },
    ],
    [
      'wrong vendor scope (cart has none of that vendor)',
      coupon({ scope: 'vendor', vendorId: 'c'.repeat(24) }),
      {},
      { reason: 'wrong_vendor' },
    ],
    [
      'percent with a cap',
      coupon({ value: 50, maxDiscountPaise: 1500 }), // 50% of 100000 = 50000, capped
      {},
      { discountPaise: 1500 },
    ],
    [
      'fixed larger than the subtotal is clamped to it',
      coupon({ type: 'fixed', value: 500000 }),
      {},
      { discountPaise: 100000 },
    ],
    ['valid percent', coupon(), {}, { discountPaise: 10000 }],
  ];

  it.each(cases)('%s', (_name, c, extra, expected) => {
    const result = evaluateCoupon(c, { lines, now: NOW, usesByCustomer: 0, ...extra });
    if (expected.reason) {
      expect(result).toEqual({ ok: false, reason: expected.reason });
    } else {
      expect(result.ok).toBe(true);
      expect(result.discountPaise).toBe(expected.discountPaise);
      expect(result.lineDiscounts.reduce((a, b) => a + b, 0)).toBe(expected.discountPaise);
    }
  });

  it('one use left under the per-user limit is still fine', () => {
    const result = evaluateCoupon(coupon({ usageLimitPerUser: 2 }), {
      lines,
      now: NOW,
      usesByCustomer: 1,
    });
    expect(result.ok).toBe(true);
  });

  it('a vendor coupon discounts only that vendor lines, and the minimum is measured on them', () => {
    const vendorA = coupon({ scope: 'vendor', vendorId: A, type: 'fixed', value: 1000 });
    const result = evaluateCoupon(vendorA, { lines, now: NOW, usesByCustomer: 0 });
    expect(result).toEqual({ ok: true, discountPaise: 1000, lineDiscounts: [1000, 0] });

    // A's own lines total 60000: a 70000 minimum fails even though the whole cart is 100000.
    const tooHigh = coupon({ scope: 'vendor', vendorId: A, minOrderPaise: 70000 });
    expect(evaluateCoupon(tooHigh, { lines, now: NOW, usesByCustomer: 0 })).toEqual({
      ok: false,
      reason: 'below_min_order',
    });
  });

  it('allocates an odd discount exactly (largest remainder)', () => {
    // 10% of 100000 split 60/40 is 6000/4000; use thirds to force remainders.
    const thirds = [
      { vendorId: A, lineSubtotalPaise: 10000 },
      { vendorId: A, lineSubtotalPaise: 10000 },
      { vendorId: B, lineSubtotalPaise: 10000 },
    ];
    const result = evaluateCoupon(coupon({ type: 'fixed', value: 1000 }), {
      lines: thirds,
      now: NOW,
      usesByCustomer: 0,
    });
    expect(result.lineDiscounts).toEqual([334, 333, 333]);
  });
});

// ---- Acceptance: "discount allocation sums exactly to total discount (1,000 random carts)" ----

describe('property: coupon discount allocation over random carts', () => {
  const vendorIds = [A, B, 'c'.repeat(24)];
  const lineArb = fc.record({
    vendorId: fc.constantFrom(...vendorIds),
    lineSubtotalPaise: fc.integer({ min: 100, max: 50_000_000 }),
  });
  const couponArb = fc.oneof(
    fc.record({
      type: fc.constant('percent'),
      value: fc.integer({ min: 1, max: 90 }),
      maxDiscountPaise: fc.option(fc.integer({ min: 1, max: 5_000_000 }), { nil: undefined }),
    }),
    fc.record({
      type: fc.constant('fixed'),
      value: fc.integer({ min: 100, max: 60_000_000 }),
      maxDiscountPaise: fc.constant(undefined),
    }),
  );

  it('shares sum exactly to the discount; uncovered lines get nothing; nothing goes negative', () => {
    fc.assert(
      fc.property(
        fc.array(lineArb, { minLength: 1, maxLength: 15 }),
        couponArb,
        fc.constantFrom('platform', ...vendorIds),
        (cartLines, shape, scopeOrVendor) => {
          const c = coupon({
            ...shape,
            scope: scopeOrVendor === 'platform' ? 'platform' : 'vendor',
            vendorId: scopeOrVendor === 'platform' ? undefined : scopeOrVendor,
          });
          const result = evaluateCoupon(c, { lines: cartLines, now: NOW, usesByCustomer: 0 });
          if (!result.ok) {
            expect(result.reason).toBe('wrong_vendor'); // the only way a fresh coupon can fail here
            return;
          }
          const covered = cartLines.map((l) => c.scope === 'platform' || l.vendorId === c.vendorId);
          const eligible = cartLines.reduce(
            (s, l, i) => (covered[i] ? s + l.lineSubtotalPaise : s),
            0,
          );

          expect(result.lineDiscounts.reduce((a, b) => a + b, 0)).toBe(result.discountPaise);
          expect(result.discountPaise).toBeLessThanOrEqual(eligible);
          if (c.maxDiscountPaise != null) {
            expect(result.discountPaise).toBeLessThanOrEqual(c.maxDiscountPaise);
          }
          result.lineDiscounts.forEach((share, i) => {
            expect(share).toBeGreaterThanOrEqual(0);
            expect(Number.isInteger(share)).toBe(true);
            if (!covered[i]) expect(share).toBe(0);
            expect(share).toBeLessThanOrEqual(cartLines[i].lineSubtotalPaise);
          });
        },
      ),
      { numRuns: 1000 },
    );
  });
});
