import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  FULFILLMENT_STATUSES,
  SETTLEMENT_STATUSES,
  SUB_ORDER_TRANSITIONS,
} from '../src/config/constants.js';
import { mulDivRoundHalfUp } from '../src/lib/money.js';
import {
  deriveOrderRefundStatus,
  deriveRefundStatus,
  netPayoutPaise,
  splitRefund,
} from '../src/lib/refunds.js';
import { assertTransition, canTransition } from '../src/modules/orders/orders.transitions.js';
import {
  assertSettlementTransition,
  canSettlementTransition,
} from '../src/modules/settlements/settlements.states.js';

const RUNS = { numRuns: 1000 };

describe('splitRefund (D9 commission, D57 vendor debit)', () => {
  it('is proportional, rounded half up: 10% of a 100000 refund', () => {
    expect(
      splitRefund({
        refundPaise: 100000,
        totalPaise: 269820,
        commissionPaise: 26982,
        vendorPayoutPaise: 242838,
        refundedBeforePaise: 0,
        commissionReversedBeforePaise: 0,
        vendorDebitBeforePaise: 0,
      }),
    ).toEqual({ commissionReversedPaise: 10000, vendorDebitPaise: 90000 });
  });

  it('the refund that exhausts the sub-order takes the commission and payout remainders', () => {
    // total 1000, commission 333, payout 667: two refunds of 333 reverse 111 and debit 222 each
    // (round(110.889), round(222.111)); the last refund of 334 takes what is left (111 and 223),
    // not the rounded share of its own.
    const common = { totalPaise: 1000, commissionPaise: 333, vendorPayoutPaise: 667 };
    const first = splitRefund({
      ...common,
      refundPaise: 333,
      refundedBeforePaise: 0,
      commissionReversedBeforePaise: 0,
      vendorDebitBeforePaise: 0,
    });
    const second = splitRefund({
      ...common,
      refundPaise: 333,
      refundedBeforePaise: 333,
      commissionReversedBeforePaise: first.commissionReversedPaise,
      vendorDebitBeforePaise: first.vendorDebitPaise,
    });
    const last = splitRefund({
      ...common,
      refundPaise: 334,
      refundedBeforePaise: 666,
      commissionReversedBeforePaise: first.commissionReversedPaise + second.commissionReversedPaise,
      vendorDebitBeforePaise: first.vendorDebitPaise + second.vendorDebitPaise,
    });
    expect(first).toEqual({ commissionReversedPaise: 111, vendorDebitPaise: 222 });
    expect(second).toEqual({ commissionReversedPaise: 111, vendorDebitPaise: 222 });
    expect(last).toEqual({ commissionReversedPaise: 111, vendorDebitPaise: 223 });
    expect(
      first.commissionReversedPaise + second.commissionReversedPaise + last.commissionReversedPaise,
    ).toBe(333);
    expect(first.vendorDebitPaise + second.vendorDebitPaise + last.vendorDebitPaise).toBe(667);
  });

  it('D57: a platform-funded coupon debits the vendor payout, not refund - commission', () => {
    // subtotal 1000, platform coupon 100 -> customer paid 900; 10% commission on the base of 1000
    // is 100, so the vendor payout is 900 (== what the customer paid, within the platform margin).
    const common = { totalPaise: 900, commissionPaise: 100, vendorPayoutPaise: 900 };
    const half = splitRefund({
      ...common,
      refundPaise: 450,
      refundedBeforePaise: 0,
      commissionReversedBeforePaise: 0,
      vendorDebitBeforePaise: 0,
    });
    // D9 commission reversal is 50; the D9-only vendor debit would have been 400.
    expect(half).toEqual({ commissionReversedPaise: 50, vendorDebitPaise: 450 });
    const rest = splitRefund({
      ...common,
      refundPaise: 450,
      refundedBeforePaise: 450,
      commissionReversedBeforePaise: half.commissionReversedPaise,
      vendorDebitBeforePaise: half.vendorDebitPaise,
    });
    expect(rest).toEqual({ commissionReversedPaise: 50, vendorDebitPaise: 450 });
  });

  it('refuses a refund above what is left, or below 1 paise', () => {
    const base = {
      totalPaise: 1000,
      commissionPaise: 100,
      vendorPayoutPaise: 900,
      refundedBeforePaise: 900,
      commissionReversedBeforePaise: 90,
      vendorDebitBeforePaise: 810,
    };
    expect(() => splitRefund({ ...base, refundPaise: 101 })).toThrow(RangeError);
    expect(() => splitRefund({ ...base, refundPaise: 0 })).toThrow(RangeError);
    expect(() => splitRefund({ ...base, refundPaise: 1.5 })).toThrow(RangeError);
    expect(() => splitRefund({ ...base, refundPaise: 10, vendorPayoutPaise: undefined })).toThrow(
      RangeError,
    );
  });

  // Acceptance: "refunding 3 x arbitrary partial amounts with a final remainder refund leaves
  // commissionReversed total == commission and the vendor's net payout at 0" (D9 + D57).
  const scenario = fc.record({
    totalPaise: fc.integer({ min: 200, max: 5_000_000 }),
    rateBps: fc.integer({ min: 0, max: 5000 }),
    weights: fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 3, maxLength: 3 }),
    platformDiscountPaise: fc.integer({ min: 0, max: 100_000 }),
  });

  function replay({ totalPaise, weights }, { grossPaise, commissionPaise }) {
    const vendorPayoutPaise = grossPaise - commissionPaise;
    let refunded = 0;
    let reversed = 0;
    let debited = 0;
    const steps = [...weights, null]; // three partials, then the remainder
    for (const w of steps) {
      const left = totalPaise - refunded;
      if (w !== null && left < 2) continue; // a partial must leave something for the remainder
      const refundPaise =
        w === null ? left : Math.max(1, Math.min(left - 1, Math.floor((left * w) / 1001)));
      const split = splitRefund({
        refundPaise,
        totalPaise,
        commissionPaise,
        vendorPayoutPaise,
        refundedBeforePaise: refunded,
        commissionReversedBeforePaise: reversed,
        vendorDebitBeforePaise: debited,
      });
      expect(split.commissionReversedPaise).toBeGreaterThanOrEqual(0);
      expect(split.vendorDebitPaise).toBeGreaterThanOrEqual(0);
      refunded += refundPaise;
      reversed += split.commissionReversedPaise;
      debited += split.vendorDebitPaise;
      expect(reversed).toBeLessThanOrEqual(commissionPaise);
      // never debit the vendor more than the transfer we sent (gross - commission)
      expect(debited).toBeLessThanOrEqual(vendorPayoutPaise);
      const net = netPayoutPaise({ grossPaise, commissionPaise, refundAdjustmentPaise: debited });
      expect(net).toBeGreaterThanOrEqual(0);
    }
    return { refunded, reversed, debited };
  }

  it('vendor-funded: reversals add up to the commission, debit == refund - reversal at every step, net ends at 0 (1,000 runs)', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const commissionPaise = mulDivRoundHalfUp(s.totalPaise, s.rateBps, 10_000);
        const out = replay(s, { grossPaise: s.totalPaise, commissionPaise });
        expect(out.refunded).toBe(s.totalPaise);
        expect(out.reversed).toBe(commissionPaise);
        expect(out.debited).toBe(s.totalPaise - commissionPaise);
        expect(
          netPayoutPaise({
            grossPaise: s.totalPaise,
            commissionPaise,
            refundAdjustmentPaise: out.debited,
          }),
        ).toBe(0);
      }),
      RUNS,
    );
  });

  it('platform-funded (gross > what the customer paid): reversals add up to the commission and a full refund leaves net payout at 0 (1,000 runs)', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const grossPaise = s.totalPaise + s.platformDiscountPaise; // base = subtotal
        const commissionPaise = mulDivRoundHalfUp(grossPaise, s.rateBps, 10_000);
        fc.pre(commissionPaise <= s.totalPaise); // checkout's exceeds_platform_margin territory otherwise
        const out = replay(s, { grossPaise, commissionPaise });
        expect(out.reversed).toBe(commissionPaise);
        // D57: the platform bears the coupon, so the whole vendor payout is debited.
        expect(out.debited).toBe(grossPaise - commissionPaise);
        expect(
          netPayoutPaise({ grossPaise, commissionPaise, refundAdjustmentPaise: out.debited }),
        ).toBe(0);
      }),
      RUNS,
    );
  });

  it('never debits the vendor a negative amount even when commission exceeds the refund', () => {
    const r = splitRefund({
      refundPaise: 100,
      totalPaise: 100,
      commissionPaise: 500,
      vendorPayoutPaise: 0,
      refundedBeforePaise: 0,
      commissionReversedBeforePaise: 0,
      vendorDebitBeforePaise: 0,
    });
    expect(r).toEqual({ commissionReversedPaise: 100, vendorDebitPaise: 0 });
  });
});

describe('refund status derivation (D4)', () => {
  it.each([
    [[], 0, 1000, 'none'],
    [['processed'], 300, 1000, 'partial'],
    [['processed', 'processed'], 1000, 1000, 'full'],
    [['processed', 'initiated'], 300, 1000, 'pending'],
    [['processed', 'failed'], 300, 1000, 'failed'],
    [['initiated', 'failed'], 300, 1000, 'pending'],
  ])('%j refunded %i of %i -> %s', (statuses, refundedPaise, totalPaise, expected) => {
    expect(deriveRefundStatus({ statuses, refundedPaise, totalPaise })).toBe(expected);
  });
  it('order aggregate', () => {
    expect(deriveOrderRefundStatus({ refundedPaise: 0, totalPaise: 5 })).toBe('none');
    expect(deriveOrderRefundStatus({ refundedPaise: 2, totalPaise: 5 })).toBe('partial');
    expect(deriveOrderRefundStatus({ refundedPaise: 5, totalPaise: 5 })).toBe('full');
  });
});

describe('sub-order transition table', () => {
  const actors = ['vendor', 'customer', 'system'];
  const cases = FULFILLMENT_STATUSES.flatMap((from) =>
    FULFILLMENT_STATUSES.flatMap((to) => actors.map((actor) => [from, to, actor])),
  );
  it.each(cases)('%s -> %s by %s matches the contract table', (from, to, actor) => {
    const allowed =
      (from === 'pending_payment' && to === 'processing' && actor === 'system') ||
      (from === 'processing' && to === 'shipped' && actor === 'vendor') ||
      (from === 'shipped' && to === 'delivered' && actor === 'vendor') ||
      (from === 'processing' && to === 'cancelled' && (actor === 'vendor' || actor === 'customer'));
    expect(canTransition(from, to, actor)).toBe(allowed);
    if (allowed) expect(() => assertTransition(from, to, actor)).not.toThrow();
    else expect(() => assertTransition(from, to, actor)).toThrow(/cannot go from/);
  });
  it('delivered and cancelled are terminal', () => {
    expect(SUB_ORDER_TRANSITIONS.delivered).toEqual({});
    expect(SUB_ORDER_TRANSITIONS.cancelled).toEqual({});
  });
});

describe('settlement state machine', () => {
  const allowed = new Set([
    'not_eligible>pending_release',
    'not_eligible>reversed',
    'pending_release>released',
    'pending_release>reversed',
    'pending_release>failed',
    'released>settled',
    'released>failed',
  ]);
  const pairs = SETTLEMENT_STATUSES.flatMap((a) => SETTLEMENT_STATUSES.map((b) => [a, b]));
  it.each(pairs)('%s -> %s', (from, to) => {
    expect(canSettlementTransition(from, to)).toBe(allowed.has(`${from}>${to}`));
    if (!allowed.has(`${from}>${to}`)) {
      expect(() => assertSettlementTransition(from, to)).toThrow(/cannot go from/);
    }
  });
  it('a settlement can reach pending_release only from not_eligible (i.e. on delivered)', () => {
    const into = pairs
      .filter(([, to]) => to === 'pending_release')
      .filter(([f, t]) => canSettlementTransition(f, t));
    expect(into).toEqual([['not_eligible', 'pending_release']]);
  });
});
