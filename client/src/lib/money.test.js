import { describe, expect, it } from 'vitest';
import { formatINR, paiseToRupees, rupeesToPaise } from './money.js';

describe('rupeesToPaise', () => {
  it.each([
    ['1499', 149900],
    ['1499.5', 149950],
    ['1499.50', 149950],
    ['0.99', 99],
    ['0.1', 10],
    ['19.99', 1999],
    ['  250  ', 25000],
  ])('%s -> %i', (input, paise) => expect(rupeesToPaise(input)).toBe(paise));

  it.each(['', '  ', 'abc', '-5', '1,499', '12.345', '1e3', '.5', '5.', '₹100', null, undefined])(
    'rejects %j',
    (input) => expect(rupeesToPaise(input)).toBeNull(),
  );

  it('never returns a fractional number (float-trap amounts)', () => {
    for (const input of ['0.07', '1.15', '4.35', '8.2', '33.33', '1234567.89']) {
      expect(Number.isInteger(rupeesToPaise(input))).toBe(true);
    }
    expect(rupeesToPaise('4.35')).toBe(435);
  });
});

describe('paiseToRupees / formatINR', () => {
  it('round-trips through the input format', () => {
    for (const paise of [100, 149900, 149950, 1999, 100000005]) {
      expect(rupeesToPaise(paiseToRupees(paise))).toBe(paise);
    }
    expect(paiseToRupees(105)).toBe('1.05');
  });

  it('formats with the rupee sign and Indian digit grouping', () => {
    expect(formatINR(149950)).toContain('1,499.50');
    expect(formatINR(10000000)).toContain('1,00,000.00');
    expect(formatINR(149950)).toContain('₹');
  });
});
