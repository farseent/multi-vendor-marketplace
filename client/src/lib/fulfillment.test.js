import { describe, expect, it } from 'vitest';
import {
  canCancelSubOrder,
  fulfillmentErrorMessage,
  refundLine,
  settlementStatusLabel,
  vendorActions,
} from './fulfillment.js';

describe('canCancelSubOrder', () => {
  it.each([
    ['pending_payment', false],
    ['processing', true],
    ['shipped', false],
    ['delivered', false],
    ['cancelled', false],
  ])('%s -> %s', (fulfillmentStatus, expected) => {
    expect(canCancelSubOrder({ fulfillmentStatus })).toBe(expected);
  });
});

describe('vendorActions mirrors the API transition table', () => {
  it.each([
    ['processing', ['ship', 'cancel']],
    ['shipped', ['deliver']],
    ['delivered', []],
    ['cancelled', []],
    ['pending_payment', []],
  ])('%s', (status, actions) => {
    expect(vendorActions(status)).toEqual(actions);
  });
});

describe('refundLine', () => {
  it('says nothing when nothing was refunded', () => {
    expect(
      refundLine({ refundStatus: 'none', refundedPaise: 0, customerTotalPaise: 50000 }),
    ).toBeNull();
  });
  it('describes partial and full refunds in rupees', () => {
    expect(
      refundLine({ refundStatus: 'partial', refundedPaise: 30000, customerTotalPaise: 50000 }),
    ).toMatch(/₹300\.00 of ₹500\.00/);
    expect(
      refundLine({ refundStatus: 'full', refundedPaise: 50000, customerTotalPaise: 50000 }),
    ).toMatch(/in full/);
  });
  it('pending and failed come before amounts', () => {
    expect(refundLine({ refundStatus: 'pending', refundedPaise: 50000 })).toBe('Refund on its way');
    expect(refundLine({ refundStatus: 'failed', refundedPaise: 50000 })).toMatch(/problem/);
  });
});

describe('labels and errors', () => {
  it('labels every settlement status and falls back to the raw value', () => {
    for (const s of [
      'not_eligible',
      'pending_release',
      'released',
      'settled',
      'reversed',
      'failed',
    ]) {
      expect(settlementStatusLabel(s)).not.toBe(s);
    }
    expect(settlementStatusLabel('mystery')).toBe('mystery');
  });
  it('turns API error codes into plain sentences', () => {
    expect(fulfillmentErrorMessage({ code: 'INVALID_STATE_TRANSITION' })).toMatch(
      /already moved on/,
    );
    expect(fulfillmentErrorMessage({ code: 'VENDOR_NOT_APPROVED' })).toMatch(/approved/);
    expect(fulfillmentErrorMessage({ code: 'X', message: 'boom' })).toBe('boom');
    expect(fulfillmentErrorMessage(undefined)).toBe('Something went wrong.');
  });
});
