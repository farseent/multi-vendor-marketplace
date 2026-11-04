import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adminErrorMessage,
  barLayout,
  bpsToPercent,
  couponRequest,
  defaultRange,
  percentOf,
  percentToBps,
  qs,
  rangeIsValid,
  refundRequest,
  vendorNextStatuses,
} from './admin.js';

afterEach(() => vi.unstubAllGlobals());

describe('qs', () => {
  it('keeps real values and leaves out empty ones', () => {
    expect(qs({ status: 'draft', q: '', page: 2, none: undefined, zero: 0 })).toBe(
      '?status=draft&page=2&zero=0',
    );
    expect(qs({})).toBe('');
    expect(qs({ q: 'a&b c' })).toBe('?q=a%26b+c');
  });
});

describe('vendorNextStatuses', () => {
  it('mirrors the API transition table', () => {
    expect(vendorNextStatuses('pending')).toEqual(['approved', 'rejected']);
    expect(vendorNextStatuses('approved')).toEqual(['suspended']);
    expect(vendorNextStatuses('suspended')).toEqual(['approved']);
    expect(vendorNextStatuses('rejected')).toEqual(['approved']);
    expect(vendorNextStatuses('nope')).toEqual([]);
  });
});

describe('percentToBps / bpsToPercent', () => {
  it.each([
    ['10', 1000],
    ['12.5', 1250],
    ['0', 0],
    ['50', 5000],
    ['7.05', 705],
    ['', null],
    ['  ', null],
    ['50.01', undefined],
    ['51', undefined],
    ['-1', undefined],
    ['1.234', undefined],
    ['abc', undefined],
  ])('%j -> %j', (text, expected) => {
    expect(percentToBps(text)).toBe(expected);
  });
  it('shows an override as a percentage and no override as empty', () => {
    expect(bpsToPercent(1250)).toBe('12.5');
    expect(bpsToPercent(null)).toBe('');
  });
});

describe('refundRequest', () => {
  const base = { note: 'Damaged item', refundablePaise: 50000 };
  it('an empty amount means everything still refundable (no amountPaise)', () => {
    expect(refundRequest({ ...base, amount: '' })).toEqual({
      ok: true,
      body: { reason: 'admin', note: 'Damaged item' },
    });
  });
  it('turns rupees into integer paise, never floats', () => {
    expect(refundRequest({ ...base, amount: '250.50' }).body.amountPaise).toBe(25050);
    expect(refundRequest({ ...base, amount: '0.07' }).body.amountPaise).toBe(7);
  });
  it('rejects a bad amount, an amount above the refundable one and a bad note', () => {
    expect(refundRequest({ ...base, amount: 'abc' }).ok).toBe(false);
    expect(refundRequest({ ...base, amount: '0' }).ok).toBe(false);
    expect(refundRequest({ ...base, amount: '500.01' })).toMatchObject({ ok: false });
    expect(refundRequest({ ...base, amount: '500.00' }).ok).toBe(true);
    expect(refundRequest({ ...base, note: 'ab', amount: '' }).ok).toBe(false);
    expect(refundRequest({ ...base, note: 'x'.repeat(301), amount: '' }).ok).toBe(false);
  });
});

describe('couponRequest', () => {
  const good = {
    code: ' save10 ',
    type: 'percent',
    value: '10',
    minOrder: '',
    maxDiscount: '',
    startsAt: '2026-11-01T00:00',
    expiresAt: '2026-12-01T00:00',
    usageLimitTotal: '',
    usageLimitPerUser: '1',
  };
  it('builds the body: upper-case code, ISO dates, optional fields only when filled', () => {
    const r = couponRequest(good);
    expect(r.ok).toBe(true);
    expect(r.body).toMatchObject({
      code: 'SAVE10',
      type: 'percent',
      value: 10,
      usageLimitPerUser: 1,
    });
    expect(r.body).not.toHaveProperty('minOrderPaise');
    expect(r.body).not.toHaveProperty('usageLimitTotal');
    expect(r.body.startsAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });
  it('a fixed coupon is in rupees on the form and paise in the body', () => {
    const r = couponRequest({
      ...good,
      type: 'fixed',
      value: '150.50',
      minOrder: '500',
      maxDiscount: '',
    });
    expect(r.body).toMatchObject({ type: 'fixed', value: 15050, minOrderPaise: 50000 });
  });
  it.each([
    [{ code: 'ab' }, 'code'],
    [{ value: '95' }, 'value'],
    [{ value: '0' }, 'value'],
    [{ type: 'fixed', value: '0.50' }, 'value'],
    [{ expiresAt: '2026-10-01T00:00' }, 'expiresAt'],
    [{ startsAt: '' }, 'startsAt'],
    [{ usageLimitPerUser: '0' }, 'usageLimitPerUser'],
    [{ maxDiscount: '0' }, 'maxDiscount'],
  ])('refuses %j (field %s)', (change, field) => {
    const r = couponRequest({ ...good, ...change });
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveProperty(field);
  });
});

describe('analytics helpers', () => {
  it('defaultRange is the last 30 UTC days, today included', () => {
    expect(defaultRange(new Date('2026-11-03T23:59:59Z'))).toEqual({
      from: '2026-10-05',
      to: '2026-11-03',
    });
    expect(defaultRange(new Date('2026-03-01T00:00:00Z'))).toEqual({
      from: '2026-01-31',
      to: '2026-03-01',
    });
  });
  it('rangeIsValid refuses a reversed or malformed range', () => {
    expect(rangeIsValid({ from: '2026-10-01', to: '2026-10-01' })).toBe(true);
    expect(rangeIsValid({ from: '2026-10-02', to: '2026-10-01' })).toBe(false);
    expect(rangeIsValid({ from: '', to: '2026-10-01' })).toBe(false);
  });
  it('barLayout scales to the largest value and keeps every bar inside the plot', () => {
    const points = [
      { bucket: 'a', gmvPaise: 0 },
      { bucket: 'b', gmvPaise: 50 },
      { bucket: 'c', gmvPaise: 100 },
    ];
    const { max, bars } = barLayout(points, 'gmvPaise', { width: 300, height: 124, pad: 12 });
    expect(max).toBe(100);
    expect(bars.map((b) => b.height)).toEqual([0, 50, 100]);
    for (const b of bars) {
      expect(b.y + b.height).toBe(124 - 12); // all bars stand on the baseline
      expect(b.x).toBeGreaterThanOrEqual(12);
      expect(b.x + b.width).toBeLessThanOrEqual(300 - 12 + 1);
    }
  });
  it('barLayout copes with no data and all zeros', () => {
    expect(barLayout([], 'gmvPaise')).toEqual({ max: 0, bars: [] });
    const zero = barLayout([{ bucket: 'a', gmvPaise: 0 }], 'gmvPaise');
    expect(zero.bars[0].height).toBe(0);
  });
  it('percentOf', () => {
    expect(percentOf(50, 200)).toBe(25);
    expect(percentOf(5, 0)).toBe(0);
  });
});

describe('adminErrorMessage', () => {
  it('explains the refund and release reasons in plain words', () => {
    expect(adminErrorMessage({ status: 409, details: { reason: 'exceeds_refundable' } })).toMatch(
      /more than the customer paid/,
    );
    expect(adminErrorMessage({ status: 422, details: { reason: 'refund_below_minimum' } })).toMatch(
      /₹1\.00/,
    );
    expect(adminErrorMessage({ status: 409, details: { reason: 'open_refund' } })).toMatch(
      /refund/,
    );
  });
  it('knows a stale state change, a provider failure and field errors', () => {
    expect(adminErrorMessage({ status: 409, code: 'INVALID_STATE_TRANSITION' })).toMatch(/Reload/);
    expect(adminErrorMessage({ status: 502, code: 'PAYMENT_PROVIDER_ERROR' })).toMatch(
      /Nothing was changed/,
    );
    expect(
      adminErrorMessage({ status: 422, details: [{ path: 'body.note', message: 'Too short' }] }),
    ).toBe('Too short');
    expect(adminErrorMessage({ status: 500, message: 'Boom' })).toBe('Boom');
  });
});
