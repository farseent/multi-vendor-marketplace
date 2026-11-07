import { describe, expect, it } from 'vitest';
import { ERROR_RATE_LIMIT, errorRate } from '../src/scripts/smoke.js';

const result = (over) => ({
  requests: { total: 1000 },
  errors: 0,
  timeouts: 0,
  non2xx: 0,
  ...over,
});

describe('smoke error rate', () => {
  it('is 0 when every request succeeded', () => {
    expect(errorRate(result())).toBe(0);
  });

  it('counts non-2xx answers, errors and timeouts together', () => {
    expect(errorRate(result({ non2xx: 5, errors: 3, timeouts: 2 }))).toBeCloseTo(10 / 1005, 5);
  });

  it('treats a run with no answers as a total failure', () => {
    expect(errorRate({ requests: { total: 0 }, errors: 0, timeouts: 0, non2xx: 0 })).toBe(1);
  });

  it('fails at the 1% limit and above, passes just below it', () => {
    expect(errorRate(result({ non2xx: 9 })) < ERROR_RATE_LIMIT).toBe(true);
    expect(errorRate(result({ non2xx: 11 })) < ERROR_RATE_LIMIT).toBe(false);
  });
});
