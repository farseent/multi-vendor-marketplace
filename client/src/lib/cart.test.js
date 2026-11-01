import { describe, expect, it } from 'vitest';
import { couponReasonMessage, lineNotice, MAX_QUANTITY, roomLeft } from './cart.js';

// Every reason the API can send (server/src/config/constants.js COUPON_REASONS).
const API_REASONS = [
  'not_found',
  'disabled',
  'not_started',
  'expired',
  'empty_cart',
  'wrong_vendor',
  'below_min_order',
  'total_limit_reached',
  'user_limit_reached',
];

describe('couponReasonMessage', () => {
  it('has its own message for every reason the API sends', () => {
    const generic = couponReasonMessage('something_new');
    for (const reason of API_REASONS) {
      expect(couponReasonMessage(reason), reason).not.toBe(generic);
    }
  });

  it('falls back to a generic message for unknown or missing reasons', () => {
    expect(couponReasonMessage('something_new')).toBe('This coupon cannot be applied.');
    expect(couponReasonMessage(undefined)).toBe('This coupon cannot be applied.');
  });
});

describe('lineNotice', () => {
  it('is null for a healthy line', () => {
    expect(lineNotice({ status: 'ok' })).toBeNull();
  });

  it('explains unavailable and low-stock lines', () => {
    expect(lineNotice({ status: 'unavailable' })).toMatch(/no longer available/i);
    expect(lineNotice({ status: 'insufficient_stock', available: 2 })).toMatch(/only 2 left/i);
    expect(lineNotice({ status: 'insufficient_stock', available: 0 })).toMatch(/out of stock/i);
  });
});

describe('roomLeft', () => {
  it('never goes negative and stops at the per-product limit', () => {
    expect(roomLeft(0)).toBe(MAX_QUANTITY);
    expect(roomLeft(4)).toBe(6);
    expect(roomLeft(MAX_QUANTITY)).toBe(0);
    expect(roomLeft(MAX_QUANTITY + 3)).toBe(0);
  });
});
