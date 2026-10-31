import { describe, expect, it } from 'vitest';
import { flattenCategories, readFilters, toApiQuery, toUrlParams } from './search.js';

const parse = (qs) => readFilters(new URLSearchParams(qs));

describe('readFilters', () => {
  it('returns defaults for an empty URL', () => {
    expect(parse('')).toEqual({
      q: '',
      category: '',
      min: '',
      max: '',
      inStock: false,
      sort: 'relevance',
      page: 1,
    });
  });

  it('reads values and ignores junk (unknown sort, bad page)', () => {
    expect(parse('q=%20kurta%20&sort=cheapest&page=abc').sort).toBe('relevance');
    expect(parse('q=%20kurta%20&page=-2')).toMatchObject({
      q: 'kurta',
      page: 1,
    });
    expect(parse('sort=price&page=3&inStock=1')).toMatchObject({
      sort: 'price',
      page: 3,
      inStock: true,
    });
  });
});

describe('toUrlParams', () => {
  it('round-trips and omits defaults', () => {
    expect(toUrlParams(parse('')).toString()).toBe('');
    const qs = 'q=kurta&category=abc&min=500&max=2000&inStock=1&sort=-price&page=2';
    expect(toUrlParams(parse(qs)).toString()).toBe(qs);
  });
});

describe('toApiQuery', () => {
  it('converts rupees to integer paise with string math', () => {
    const q = new URLSearchParams(
      toApiQuery(parse('min=499.50&max=2000&inStock=1&category=c1&q=kurta')),
    );
    expect(q.get('minPrice')).toBe('49950');
    expect(q.get('maxPrice')).toBe('200000');
    expect(q.get('inStock')).toBe('true');
    expect(q.get('categoryId')).toBe('c1');
    expect(q.get('q')).toBe('kurta');
    expect(q.get('limit')).toBe('20');
  });

  it('drops invalid prices instead of sending garbage', () => {
    const q = new URLSearchParams(toApiQuery(parse('min=abc&max=12.345')));
    expect(q.has('minPrice')).toBe(false);
    expect(q.has('maxPrice')).toBe(false);
  });
});

describe('flattenCategories', () => {
  it('lists parents followed by indented children', () => {
    const tree = [
      { id: '1', name: 'Clothing', children: [{ id: '2', name: 'Kurtas' }] },
      { id: '3', name: 'Home' },
    ];
    expect(flattenCategories(tree)).toEqual([
      { id: '1', label: 'Clothing' },
      { id: '2', label: '— Kurtas' },
      { id: '3', label: 'Home' },
    ]);
  });
});