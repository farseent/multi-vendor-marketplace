import { describe, expect, it } from 'vitest';
import { getAccessDecision } from './access.js';

const customer = { id: '1', role: 'customer' };

describe('getAccessDecision', () => {
  it.each([
    [{ status: 'loading', user: null }, 'loading'],
    [{ status: 'anonymous', user: null }, 'login'],
    [{ status: 'authenticated', user: null }, 'login'],
    [{ status: 'authenticated', user: customer }, 'allow'],
    [{ status: 'authenticated', user: customer, roles: ['customer', 'vendor'] }, 'allow'],
    [{ status: 'authenticated', user: customer, roles: ['vendor'] }, 'forbidden'],
    [{ status: 'authenticated', user: customer, roles: [] }, 'allow'],
    [{ status: 'anonymous', user: null, roles: ['vendor'] }, 'login'],
  ])('%j -> %s', (input, expected) => {
    expect(getAccessDecision(input)).toBe(expected);
  });
});
