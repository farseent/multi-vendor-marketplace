import { describe, expect, it } from 'vitest';
import {
  buildCategoryTree,
  categoryCounts,
  categoryErrors,
  categoryRequest,
  categoryRows,
  categoryToForm,
  commissionLabel,
  emptyCategoryForm,
  hasChildren,
  parentChoices,
} from './categories.js';

// Shaped like GET /admin/categories: a flat list, every field, `id` and `parentId` as strings.
const make = (id, name, extra = {}) => ({
  id,
  name,
  slug: name.toLowerCase().replaceAll(' ', '-'),
  parentId: null,
  defaultCommissionBps: null,
  isActive: true,
  sortOrder: 0,
  ...extra,
});

const CLOTHING = make('c1', 'Clothing', { sortOrder: 1 });
const KURTAS = make('c2', 'Kurtas', { parentId: 'c1', sortOrder: 2 });
const SAREES = make('c3', 'Sarees', { parentId: 'c1', sortOrder: 1 });
const HOME = make('h1', 'Home', { sortOrder: 0, isActive: false, defaultCommissionBps: 1250 });
const DECOR = make('h2', 'Decor', { parentId: 'h1' });
const ALL = [KURTAS, CLOTHING, DECOR, SAREES, HOME];

const form = (over = {}) => ({ ...emptyCategoryForm(), name: 'Toys', ...over });

describe('buildCategoryTree / categoryRows', () => {
  it('nests children under their parent, ordered by sortOrder then name', () => {
    const tree = buildCategoryTree(ALL);
    expect(tree.map((r) => r.name)).toEqual(['Home', 'Clothing']);
    expect(tree[1].children.map((c) => c.name)).toEqual(['Sarees', 'Kurtas']);
  });

  it('shows a child whose parent is missing at the top level instead of losing it', () => {
    const tree = buildCategoryTree([make('x', 'Orphan', { parentId: 'gone' })]);
    expect(tree.map((r) => r.name)).toEqual(['Orphan']);
  });

  it('flattens to rows with depth, and flags active children of an inactive parent', () => {
    const rows = categoryRows(buildCategoryTree(ALL));
    expect(rows.map((r) => [r.category.name, r.depth])).toEqual([
      ['Home', 0],
      ['Decor', 1],
      ['Clothing', 0],
      ['Sarees', 1],
      ['Kurtas', 1],
    ]);
    expect(rows.find((r) => r.category.name === 'Decor').hiddenByParent).toBe(true);
    expect(rows.find((r) => r.category.name === 'Sarees').hiddenByParent).toBe(false);
    expect(rows.find((r) => r.category.name === 'Home').hiddenByParent).toBe(false);
  });

  it('copes with an empty list', () => {
    expect(buildCategoryTree([])).toEqual([]);
    expect(categoryRows([])).toEqual([]);
  });
});

describe('categoryCounts', () => {
  it('counts top-level, sub-categories and inactive categories', () => {
    expect(categoryCounts(ALL)).toEqual({ topLevel: 2, subCategories: 3, inactive: 1 });
  });
});

describe('parentChoices / hasChildren', () => {
  it('offers top-level categories only, and never the category being edited', () => {
    expect(parentChoices(ALL).map((c) => c.id)).toEqual(['h1', 'c1']);
    expect(parentChoices(ALL, 'c1').map((c) => c.id)).toEqual(['h1']);
  });
  it('knows whether a category has sub-categories', () => {
    expect(hasChildren(ALL, 'c1')).toBe(true);
    expect(hasChildren(ALL, 'c2')).toBe(false);
  });
});

describe('commissionLabel', () => {
  it('says "Platform default" when there is no override', () => {
    expect(commissionLabel(CLOTHING)).toBe('Platform default');
    expect(commissionLabel(HOME)).toBe('12.5%');
    expect(commissionLabel(make('z', 'Zero', { defaultCommissionBps: 0 }))).toBe('0%');
  });
});

describe('categoryToForm', () => {
  it('turns an API category into form text', () => {
    expect(categoryToForm(HOME)).toEqual({
      name: 'Home',
      slug: 'home',
      parentId: '',
      defaultCommission: '12.5',
      sortOrder: '0',
      isActive: false,
    });
    expect(categoryToForm(KURTAS).parentId).toBe('c1');
  });
});

describe('categoryRequest (create)', () => {
  it('builds a minimal body and leaves out an empty slug, parent and commission', () => {
    expect(categoryRequest(form(), { categories: ALL })).toEqual({
      ok: true,
      body: { name: 'Toys', sortOrder: 0, isActive: true },
    });
  });

  it('trims the name, lowercases the slug and converts percent to basis points', () => {
    const result = categoryRequest(
      form({
        name: '  Hand Looms ',
        slug: ' Hand-Looms ',
        parentId: 'c1',
        defaultCommission: '7.5',
        sortOrder: '12',
        isActive: false,
      }),
      { categories: ALL },
    );
    expect(result).toEqual({
      ok: true,
      body: {
        name: 'Hand Looms',
        slug: 'hand-looms',
        parentId: 'c1',
        defaultCommissionBps: 750,
        sortOrder: 12,
        isActive: false,
      },
    });
  });

  it('sends a 0% commission (that is an override, not "use the default")', () => {
    const { body } = categoryRequest(form({ defaultCommission: '0' }), { categories: ALL });
    expect(body.defaultCommissionBps).toBe(0);
  });

  it.each([
    ['a', 'name'],
    ['x'.repeat(61), 'name'],
    ['   ', 'name'],
  ])('rejects the name %j', (name, field) => {
    expect(categoryRequest(form({ name }), { categories: ALL }).errors).toHaveProperty(field);
  });

  it.each(['Has Space', 'double--hyphen', '-lead', 'trail-', 'under_score', 'ü'])(
    'rejects the slug %j',
    (slug) => {
      expect(categoryRequest(form({ slug }), { categories: ALL }).errors.slug).toMatch(/lowercase/);
    },
  );

  it('rejects a slug longer than 80 characters', () => {
    expect(
      categoryRequest(form({ slug: 'a'.repeat(81) }), { categories: ALL }).errors.slug,
    ).toMatch(/80/);
  });

  it('refuses a parent that is itself a sub-category, or that does not exist', () => {
    expect(categoryRequest(form({ parentId: 'c2' }), { categories: ALL }).errors.parentId).toMatch(
      /two levels/,
    );
    expect(
      categoryRequest(form({ parentId: 'nope' }), { categories: ALL }).errors.parentId,
    ).toMatch(/Choose a parent/);
  });

  it.each(['51', '-1', '1.234', 'abc'])('rejects the commission %j', (defaultCommission) => {
    expect(
      categoryRequest(form({ defaultCommission }), { categories: ALL }).errors.defaultCommission,
    ).toBeTruthy();
  });

  it.each(['-1', '1.5', 'x', '10000', ''])('rejects the sort order %j', (sortOrder) => {
    expect(categoryRequest(form({ sortOrder }), { categories: ALL }).errors.sortOrder).toBeTruthy();
  });

  it('reports every problem at once', () => {
    const { errors } = categoryRequest(
      form({ name: '', sortOrder: 'x', defaultCommission: '99' }),
      {
        categories: ALL,
      },
    );
    expect(Object.keys(errors).sort()).toEqual(['defaultCommission', 'name', 'sortOrder']);
  });
});

describe('categoryRequest (edit)', () => {
  const edit = (category, over) =>
    categoryRequest(
      { ...categoryToForm(category), ...over },
      { categories: ALL, original: category },
    );

  it('sends only the fields that changed', () => {
    expect(edit(KURTAS, { name: 'Cotton Kurtas' })).toEqual({
      ok: true,
      body: { name: 'Cotton Kurtas' },
    });
    expect(edit(KURTAS, { isActive: false, sortOrder: '5' }).body).toEqual({
      isActive: false,
      sortOrder: 5,
    });
  });

  it('reports "nothing changed" instead of sending an empty patch (the API refuses one)', () => {
    expect(edit(KURTAS, {})).toEqual({ ok: false, errors: {}, unchanged: true });
  });

  it('never sends the slug, even if it was typed over', () => {
    expect(edit(KURTAS, { slug: 'something-else', name: 'Kurtas 2' }).body).toEqual({
      name: 'Kurtas 2',
    });
  });

  it('un-nests with parentId null and clears an override with null', () => {
    expect(edit(KURTAS, { parentId: '' }).body).toEqual({ parentId: null });
    expect(edit(HOME, { defaultCommission: '' }).body).toEqual({ defaultCommissionBps: null });
    expect(edit(HOME, { defaultCommission: '10' }).body).toEqual({ defaultCommissionBps: 1000 });
  });

  it('moves a childless category under another top-level one', () => {
    expect(edit(KURTAS, { parentId: 'h1' }).body).toEqual({ parentId: 'h1' });
  });

  it('refuses to make a category its own parent', () => {
    expect(edit(CLOTHING, { parentId: 'c1' }).errors.parentId).toMatch(/own parent/);
  });

  it('refuses to nest a category that has sub-categories (API rule)', () => {
    expect(edit(CLOTHING, { parentId: 'h1' }).errors.parentId).toMatch(/sub-categories/);
  });

  it('refuses a sub-category as the new parent', () => {
    expect(edit(HOME, { parentId: 'c2' }).errors.parentId).toMatch(/two levels/);
  });
});

describe('categoryErrors', () => {
  it('puts 422 details on the matching form fields', () => {
    const error = {
      status: 422,
      details: [
        { path: 'body.parentId', message: 'Categories can be nested only two levels deep' },
        { path: 'body.name', message: 'Too short' },
      ],
    };
    expect(categoryErrors(error)).toEqual({
      fieldErrors: {
        parentId: 'Categories can be nested only two levels deep',
        name: 'Too short',
      },
      message: null,
    });
  });

  it('explains a 409 on the slug, or on the name when the slug was derived from it', () => {
    expect(categoryErrors({ status: 409 }, { slugGiven: true }).fieldErrors.slug).toMatch(/slug/);
    expect(categoryErrors({ status: 409 }).fieldErrors.name).toMatch(/name/);
  });

  it('shows a general message when no field matches', () => {
    expect(categoryErrors({ status: 404 }).message).toMatch(/no longer exists/);
    expect(categoryErrors({ status: 500, message: 'Boom' }).message).toBe('Boom');
    // a detail that belongs to no form field (e.g. the URL) falls back to the general message
    const stray = categoryErrors({
      status: 422,
      message: 'Invalid request',
      details: [{ path: 'params.categoryId', message: 'Bad id' }],
    });
    expect(stray.fieldErrors).toEqual({});
    expect(stray.message).toBe('Invalid request');
    expect(categoryErrors(undefined).message).toBe('Something went wrong.');
  });
});