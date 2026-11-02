import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';
import {
  computeSubOrderMoney,
  initialSettlementMoney,
  resolveCommissionRate,
} from '../src/lib/commission.js';
import { evaluateCoupon } from '../src/modules/coupons/coupons.rules.js';
import { Counter, Order, SubOrder } from '../src/modules/orders/orders.model.js';
import { buildOrderDraft } from '../src/modules/orders/orders.money.js';
import { Payment, WebhookEvent } from '../src/modules/payments/payments.model.js';
import { Refund } from '../src/modules/refunds/refunds.model.js';
import { Settlement } from '../src/modules/settlements/settlements.model.js';
import { assertPaymentProvider } from '../src/providers/payment/PaymentProvider.js';
import { createMockLedger } from '../src/providers/payment/mockLedger.js';
import { safeEqualHex } from '../src/providers/payment/signatures.js';

describe('resolveCommissionRate (D6, D52)', () => {
  const platformBps = 1000;
  it.each([
    ['vendor override wins', { vendorBps: 500, categoryBps: [800, 800] }, 500, 'vendor'],
    ['a vendor override of 0 still wins', { vendorBps: 0, categoryBps: [800] }, 0, 'vendor'],
    ['one shared category rate', { vendorBps: null, categoryBps: [800, 800] }, 800, 'category'],
    ['categories that disagree', { vendorBps: null, categoryBps: [800, 900] }, 1000, 'platform'],
    [
      'a category without a default',
      { vendorBps: null, categoryBps: [800, null] },
      1000,
      'platform',
    ],
    ['no category default at all', { vendorBps: null, categoryBps: [null] }, 1000, 'platform'],
    ['no items', { vendorBps: undefined, categoryBps: [] }, 1000, 'platform'],
  ])('%s', (_name, input, rateBps, rateSource) => {
    expect(resolveCommissionRate({ ...input, platformBps })).toEqual({ rateBps, rateSource });
  });
});

describe('computeSubOrderMoney (D6)', () => {
  it('vendor-funded discount: the vendor carries it (DATABASE_SCHEMA example)', () => {
    expect(
      computeSubOrderMoney({
        subtotalPaise: 299800,
        discountPaise: 29980,
        fundedBy: 'vendor',
        rateBps: 1000,
      }),
    ).toEqual({
      customerTotalPaise: 269820,
      basePaise: 269820,
      commissionPaise: 26982,
      vendorPayoutPaise: 242838,
    });
  });

  it('platform-funded discount: customer pays less, vendor payout is unchanged', () => {
    const m = computeSubOrderMoney({
      subtotalPaise: 299800,
      discountPaise: 29980,
      fundedBy: 'platform',
      rateBps: 1000,
    });
    expect(m.customerTotalPaise).toBe(269820);
    expect(m.basePaise).toBe(299800);
    expect(m.commissionPaise).toBe(29980);
    expect(m.vendorPayoutPaise).toBe(269820);
  });

  it('rounds half up on odd paise', () => {
    // 5% of 10 paise = 0.5 -> 1
    expect(
      computeSubOrderMoney({
        subtotalPaise: 10,
        discountPaise: 0,
        fundedBy: 'vendor',
        rateBps: 500,
      }).commissionPaise,
    ).toBe(1);
  });

  it('refuses a discount larger than the subtotal', () => {
    expect(() =>
      computeSubOrderMoney({
        subtotalPaise: 100,
        discountPaise: 101,
        fundedBy: 'vendor',
        rateBps: 1,
      }),
    ).toThrow(RangeError);
  });

  it('starts a settlement with nothing refunded', () => {
    expect(initialSettlementMoney({ basePaise: 1000, commissionPaise: 100 })).toEqual({
      grossPaise: 1000,
      commissionPaise: 100,
      refundAdjustmentPaise: 0,
      netPayoutPaise: 900,
    });
  });
});

// ---- 1,000-run property tests (IMPLEMENTATION_PLAN Phase 5 acceptance) ----
const VENDORS = ['v1', 'v2', 'v3', 'v4'];
const lineArb = fc.record({
  vendorId: fc.constantFrom(...VENDORS),
  categoryId: fc.constantFrom('c1', 'c2', 'c3'),
  unitPricePaise: fc.integer({ min: 100, max: 500_000 }),
  quantity: fc.integer({ min: 1, max: 10 }),
});
const bpsArb = fc.option(fc.integer({ min: 0, max: 5000 }), { nil: null });
const couponArb = fc.option(
  fc.record({
    scope: fc.constantFrom('platform', 'vendor'),
    vendorId: fc.constantFrom(...VENDORS),
    kind: fc.oneof(
      fc.record({ type: fc.constant('percent'), value: fc.integer({ min: 1, max: 90 }) }),
      fc.record({ type: fc.constant('fixed'), value: fc.integer({ min: 100, max: 2_000_000 }) }),
    ),
    cap: fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: null }),
  }),
  { nil: null },
);

function draftFor({ lines, coupon, vendorBps, categoryBps, platformBps }) {
  const cartLines = lines.map((l, i) => ({
    ...l,
    productId: `p${i}`,
    title: 't',
    sku: 's',
    imageKey: 'k',
  }));
  let evaluation = null;
  let fundedBy = 'vendor';
  if (coupon) {
    const c = {
      status: 'active',
      startsAt: new Date(0),
      expiresAt: new Date(2e12),
      scope: coupon.scope,
      vendorId: coupon.vendorId,
      type: coupon.kind.type,
      value: coupon.kind.value,
      maxDiscountPaise: coupon.kind.type === 'percent' ? (coupon.cap ?? undefined) : undefined,
      minOrderPaise: 0,
      usedCount: 0,
      usageLimitPerUser: 1,
    };
    const result = evaluateCoupon(c, {
      lines: cartLines.map((l) => ({
        vendorId: l.vendorId,
        lineSubtotalPaise: l.unitPricePaise * l.quantity,
      })),
      now: new Date(1e12),
      usesByCustomer: 0,
    });
    if (result.ok) {
      evaluation = result;
      fundedBy = coupon.scope === 'platform' ? 'platform' : 'vendor';
    }
  }
  const draft = buildOrderDraft({
    lines: cartLines,
    evaluation,
    fundedBy,
    platformBps,
    vendorBpsById: new Map(VENDORS.map((v, i) => [v, vendorBps[i]])),
    categoryBpsById: new Map(['c1', 'c2', 'c3'].map((c, i) => [c, categoryBps[i]])),
  });
  return { draft, evaluation, fundedBy, cartLines };
}

const cartArb = fc.record({
  lines: fc.array(lineArb, { minLength: 1, maxLength: 12 }),
  coupon: couponArb,
  vendorBps: fc.array(bpsArb, { minLength: 4, maxLength: 4 }),
  categoryBps: fc.array(bpsArb, { minLength: 3, maxLength: 3 }),
  platformBps: fc.integer({ min: 0, max: 5000 }),
});

describe('buildOrderDraft properties (1,000 random carts)', () => {
  it('sub-order totals add up to the order total, and commission + payout = base', () => {
    fc.assert(
      fc.property(cartArb, (input) => {
        const { draft, evaluation, fundedBy, cartLines } = draftFor(input);

        // one sub-order per vendor in the cart, no empty ones
        const vendors = new Set(cartLines.map((l) => l.vendorId));
        expect(draft.subOrders).toHaveLength(vendors.size);

        // sum(subOrders.customerTotalPaise) == order.totalPaise
        expect(draft.subOrders.reduce((s, so) => s + so.customerTotalPaise, 0)).toBe(
          draft.totalPaise,
        );
        expect(draft.totalPaise).toBe(draft.subtotalPaise - draft.discountPaise);
        expect(draft.discountPaise).toBe(evaluation?.discountPaise ?? 0);

        for (const so of draft.subOrders) {
          // commission + vendorPayout == base, always (incl. odd-paise rounding)
          expect(so.commission.amountPaise + so.vendorPayoutPaise).toBe(so.commission.basePaise);
          expect(so.vendorPayoutPaise).toBeGreaterThanOrEqual(0);
          expect(so.customerTotalPaise).toBe(so.subtotalPaise - so.discountPaise);
          expect(so.customerTotalPaise).toBeGreaterThanOrEqual(0);
          // base follows the funding rule (D6)
          const expectedBase = fundedBy === 'platform' ? so.subtotalPaise : so.customerTotalPaise;
          expect(so.commission.basePaise).toBe(expectedBase);
          // line snapshot maths
          for (const item of so.items) {
            expect(item.lineNetPaise).toBe(item.lineSubtotalPaise - item.discountPaise);
          }
          expect(so.items.reduce((s, i) => s + i.lineNetPaise, 0)).toBe(so.customerTotalPaise);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('a vendor-funded coupon never touches another vendor’s sub-order', () => {
    fc.assert(
      fc.property(cartArb, (input) => {
        const coupon = input.coupon && { ...input.coupon, scope: 'vendor' };
        const { draft } = draftFor({ ...input, coupon });
        if (!coupon) return;
        for (const so of draft.subOrders) {
          if (so.vendorId !== coupon.vendorId) expect(so.discountPaise).toBe(0);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('numbers sub-orders deterministically (sorted by vendor id)', () => {
    const { draft } = draftFor({
      lines: [
        { vendorId: 'v3', categoryId: 'c1', unitPricePaise: 100, quantity: 1 },
        { vendorId: 'v1', categoryId: 'c1', unitPricePaise: 100, quantity: 1 },
      ],
      coupon: null,
      vendorBps: [null, null, null, null],
      categoryBps: [null, null, null],
      platformBps: 1000,
    });
    expect(draft.subOrders.map((s) => s.vendorId)).toEqual(['v1', 'v3']);
  });
});

describe('environment (D44-D51)', () => {
  const VALID = {
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://localhost:27017/marketplace',
    REDIS_URL: 'redis://localhost:6379',
    ELASTICSEARCH_URL: 'http://localhost:9200',
    CORS_ORIGINS: 'http://localhost:5173',
    JWT_ACCESS_SECRET: 'unit-test-secret-unit-test-secret-1234',
  };
  const RAZORPAY = {
    PAYMENT_PROVIDER: 'razorpay',
    RAZORPAY_KEY_ID: 'rzp_test_x',
    RAZORPAY_KEY_SECRET: 'secret',
    RAZORPAY_WEBHOOK_SECRET: 'whsec',
  };

  it('defaults to the mock provider and a 1000 bps platform commission', () => {
    const env = parseEnv(VALID);
    expect(env.PAYMENT_PROVIDER).toBe('mock');
    expect(env.PLATFORM_COMMISSION_BPS).toBe(1000);
  });

  it.each(['', undefined])('treats %j as unset, never as 0', (value) => {
    expect(parseEnv({ ...VALID, PLATFORM_COMMISSION_BPS: value }).PLATFORM_COMMISSION_BPS).toBe(
      1000,
    );
  });

  it.each([
    ['0', 0],
    ['500', 500],
    ['5000', 5000],
  ])('accepts PLATFORM_COMMISSION_BPS=%s', (value, expected) => {
    expect(parseEnv({ ...VALID, PLATFORM_COMMISSION_BPS: value }).PLATFORM_COMMISSION_BPS).toBe(
      expected,
    );
  });

  it.each(['-1', '5001', '10.5', 'abc', '1e9'])('rejects PLATFORM_COMMISSION_BPS=%s', (value) => {
    expect(() => parseEnv({ ...VALID, PLATFORM_COMMISSION_BPS: value })).toThrow(
      /PLATFORM_COMMISSION_BPS/,
    );
  });

  it('requires the Razorpay credentials only for the razorpay provider', () => {
    expect(() => parseEnv({ ...VALID, PAYMENT_PROVIDER: 'razorpay' })).toThrow(/RAZORPAY_KEY_ID/);
    expect(parseEnv({ ...VALID, ...RAZORPAY }).PAYMENT_PROVIDER).toBe('razorpay');
  });

  it('refuses the mock ledger in production', () => {
    expect(() => parseEnv({ ...VALID, NODE_ENV: 'production' })).toThrow(/PAYMENT_PROVIDER/);
    expect(parseEnv({ ...VALID, NODE_ENV: 'production', ...RAZORPAY }).NODE_ENV).toBe('production');
  });

  it('does not echo secrets in error text', () => {
    try {
      parseEnv({ ...VALID, PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_SECRET: 'topsecretvalue' });
    } catch (err) {
      expect(err.message).not.toContain('topsecretvalue');
    }
  });
});

describe('MockLedgerProvider', () => {
  const vendor = { id: 'abc123' };

  it('satisfies the PaymentProvider contract', () => {
    expect(() => assertPaymentProvider(createMockLedger())).not.toThrow();
    expect(() => assertPaymentProvider({ name: 'x' })).toThrow(/Invalid payment provider/);
  });

  it('creates an order with on-hold transfers and returns their ids', async () => {
    const ledger = createMockLedger();
    const res = await ledger.createOrder({
      amountPaise: 1000,
      receipt: 'MP-1',
      transfers: [
        { linkedAccountId: 'acc_a', amountPaise: 400 },
        { linkedAccountId: 'acc_b', amountPaise: 500 },
      ],
    });
    expect(res.providerOrderId).toMatch(/^order_mock_/);
    expect(res.transfers.map((t) => t.linkedAccountId)).toEqual(['acc_a', 'acc_b']);
    expect(ledger.state.orders.get(res.providerOrderId).transfers.every((t) => t.onHold)).toBe(
      true,
    );
  });

  it.each([
    ['an order below 100 paise', { amountPaise: 99, transfers: [] }],
    [
      'a transfer below 100 paise',
      { amountPaise: 1000, transfers: [{ linkedAccountId: 'a', amountPaise: 99 }] },
    ],
    [
      'transfers adding up to more than the order',
      {
        amountPaise: 1000,
        transfers: [
          { linkedAccountId: 'a', amountPaise: 600 },
          { linkedAccountId: 'b', amountPaise: 401 },
        ],
      },
    ],
  ])('enforces the documented Razorpay limit: %s', async (_name, input) => {
    await expect(createMockLedger().createOrder({ receipt: 'r', ...input })).rejects.toMatchObject({
      code: 'PAYMENT_PROVIDER_ERROR',
      status: 502,
    });
  });

  it('signs and verifies the checkout callback; rejects a tampered one', async () => {
    const ledger = createMockLedger();
    const { providerOrderId } = await ledger.createOrder({ amountPaise: 500, receipt: 'r' });
    const { providerPaymentId, signature } = ledger.simulatePayment(providerOrderId);
    expect(ledger.verifyCheckoutSignature({ providerOrderId, providerPaymentId, signature })).toBe(
      true,
    );
    expect(
      ledger.verifyCheckoutSignature({
        providerOrderId,
        providerPaymentId: 'pay_other',
        signature,
      }),
    ).toBe(false);
    expect(
      ledger.verifyCheckoutSignature({ providerOrderId, providerPaymentId, signature: 'zz' }),
    ).toBe(false);
  });

  it('signs webhooks over the raw body and rejects a modified body', async () => {
    const ledger = createMockLedger();
    const { providerOrderId } = await ledger.createOrder({ amountPaise: 500, receipt: 'r' });
    const { providerPaymentId } = ledger.simulatePayment(providerOrderId);
    const { rawBody, headers } = ledger.buildWebhook('payment.captured', {
      providerOrderId,
      providerPaymentId,
    });
    expect(ledger.verifyWebhookSignature(rawBody, headers['x-razorpay-signature'])).toBe(true);
    const tampered = Buffer.from(rawBody.toString().replace('captured', 'failed_'));
    expect(ledger.verifyWebhookSignature(tampered, headers['x-razorpay-signature'])).toBe(false);
    expect(ledger.verifyWebhookSignature(rawBody, undefined)).toBe(false);
  });

  it('refunds only captured payments and is replay-safe per receipt', async () => {
    const ledger = createMockLedger();
    const { providerOrderId } = await ledger.createOrder({ amountPaise: 500, receipt: 'r' });
    const { providerPaymentId } = ledger.simulatePayment(providerOrderId);
    const a = await ledger.refundPayment({ providerPaymentId, amountPaise: 500, receipt: 'rf1' });
    const b = await ledger.refundPayment({ providerPaymentId, amountPaise: 500, receipt: 'rf1' });
    expect(b).toEqual(a);
    const pending = ledger.simulatePayment(providerOrderId, { status: 'authorized' });
    await expect(
      ledger.refundPayment({ providerPaymentId: pending.providerPaymentId, amountPaise: 1 }),
    ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_ERROR' });
  });

  it('derives a deterministic active payout account and validates only that one (D49)', async () => {
    const ledger = createMockLedger();
    expect(await ledger.resolvePayoutAccount(vendor)).toEqual({
      linkedAccountId: 'acc_mockabc123',
      active: true,
    });
    expect(
      await ledger.validateLinkedAccount({ vendor, linkedAccountId: 'acc_mockabc123' }),
    ).toEqual({
      ok: true,
    });
    expect(
      await ledger.validateLinkedAccount({ vendor, linkedAccountId: 'acc_other' }),
    ).toMatchObject({
      ok: false,
    });
  });

  it('can be told to fail once, for compensation tests', async () => {
    const ledger = createMockLedger();
    ledger.failNext('createOrder');
    await expect(ledger.createOrder({ amountPaise: 500, receipt: 'r' })).rejects.toMatchObject({
      status: 502,
    });
    await expect(ledger.createOrder({ amountPaise: 500, receipt: 'r' })).resolves.toBeDefined();
  });
});

describe('safeEqualHex', () => {
  it('is false for malformed input and different lengths, never throws', () => {
    expect(safeEqualHex('abcd', 'abcd')).toBe(true);
    expect(safeEqualHex('abcd', 'abce')).toBe(false);
    expect(safeEqualHex('abcd', 'abc')).toBe(false);
    expect(safeEqualHex('abcd', 'zzzz')).toBe(false);
    expect(safeEqualHex('abcd', undefined)).toBe(false);
    expect(safeEqualHex(undefined, 'abcd')).toBe(false);
  });
});

describe('collection names follow the plural camelCase convention (PROJECT_MASTER 6)', () => {
  it.each([
    [Order, 'orders'],
    [SubOrder, 'subOrders'],
    [Payment, 'payments'],
    [Settlement, 'settlements'],
    [Refund, 'refunds'],
    [WebhookEvent, 'webhookEvents'],
    [Counter, 'counters'],
  ])('%s.collection', (model, name) => {
    expect(model.collection.name).toBe(name);
  });
});
