import { bpsToPercent, percentToBps } from './admin.js';

// Admin category screen helpers. The API is the authority: it enforces every rule below
// (categories.validator.js and categories.service.js). These functions only turn form text into
// the API's bodies, show the two-level hierarchy, and give friendlier messages before a request.

export const NAME_MIN = 2;
export const NAME_MAX = 60;
export const SLUG_MAX = 80;
export const SORT_ORDER_MAX = 9999;

/** Same rule as the API: lowercase words joined by single hyphens. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ---- forms ----

/** An empty form. `parentId` pre-selects a parent (the "Add sub-category" action). */
export const emptyCategoryForm = (parentId = '') => ({
  name: '',
  slug: '',
  parentId,
  defaultCommission: '',
  sortOrder: '0',
  isActive: true,
});

/** An API category -> the form's text fields. */
export const categoryToForm = (category) => ({
  name: category.name,
  slug: category.slug,
  parentId: category.parentId ?? '',
  defaultCommission: bpsToPercent(category.defaultCommissionBps),
  sortOrder: String(category.sortOrder ?? 0),
  isActive: category.isActive,
});

// ---- hierarchy ----

/** Same order as the API's public tree: sortOrder, then name. */
const byOrder = (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

/**
 * The flat admin list -> top-level categories, each with its sorted `children`.
 * A child whose parent is missing from the list is shown at the top level rather than lost.
 */
export function buildCategoryTree(categories = []) {
  const ids = new Set(categories.map((c) => c.id));
  const isChild = (c) => Boolean(c.parentId) && ids.has(c.parentId);
  return categories
    .filter((c) => !isChild(c))
    .sort(byOrder)
    .map((root) => ({
      ...root,
      children: categories.filter((c) => c.parentId === root.id).sort(byOrder),
    }));
}

/**
 * The tree as table rows: each parent followed by its children.
 * `hiddenByParent` marks an active child under an inactive parent: the public tree only lists
 * children of active parents, so customers and the vendor product form cannot see it.
 */
export function categoryRows(tree) {
  return tree.flatMap((root) => [
    { category: root, depth: 0, hiddenByParent: false },
    ...root.children.map((child) => ({
      category: child,
      depth: 1,
      hiddenByParent: child.isActive && !root.isActive,
    })),
  ]);
}

export function categoryCounts(categories = []) {
  const tree = buildCategoryTree(categories);
  const topLevel = tree.length;
  return {
    topLevel,
    subCategories: categories.length - topLevel,
    inactive: categories.filter((c) => !c.isActive).length,
  };
}

/** Categories that may be chosen as a parent: top-level ones, and never the category itself. */
export const parentChoices = (categories = [], selfId) =>
  buildCategoryTree(categories).filter((c) => c.id !== selfId);

/** A category that has sub-categories cannot itself be nested under another (the API refuses). */
export const hasChildren = (categories = [], categoryId) =>
  categories.some((c) => c.parentId === categoryId);

export const commissionLabel = (category) =>
  category.defaultCommissionBps === null || category.defaultCommissionBps === undefined
    ? 'Platform default'
    : `${bpsToPercent(category.defaultCommissionBps)}%`;

// ---- requests ----

/**
 * The form -> an API body, or { ok: false, errors: { field: message } }.
 *  - create: sends every field the form shows; an empty slug is left out so the API derives it.
 *  - edit (pass `original`): sends only what changed, and never the slug (changing it would
 *    break existing links). `{ ok: false, errors: {}, unchanged: true }` when nothing changed.
 */
export function categoryRequest(form, { categories = [], original } = {}) {
  const errors = {};
  const name = String(form.name ?? '').trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    errors.name = `Use ${NAME_MIN} to ${NAME_MAX} characters.`;
  }

  const slug = String(form.slug ?? '')
    .trim()
    .toLowerCase();
  if (!original && slug !== '') {
    if (slug.length > SLUG_MAX) errors.slug = `At most ${SLUG_MAX} characters.`;
    else if (!SLUG_PATTERN.test(slug)) {
      errors.slug = 'Use lowercase letters, digits and single hyphens, like "home-decor".';
    }
  }

  const parentId = String(form.parentId ?? '');
  if (parentId) {
    const parent = categories.find((c) => c.id === parentId);
    if (original && parentId === original.id)
      errors.parentId = 'A category cannot be its own parent.';
    else if (!parent) errors.parentId = 'Choose a parent from the list.';
    else if (parent.parentId) errors.parentId = 'Categories can be nested only two levels deep.';
    else if (original && hasChildren(categories, original.id)) {
      errors.parentId = 'A category with sub-categories cannot be nested under another.';
    }
  }

  const commission = percentToBps(form.defaultCommission);
  if (commission === undefined) {
    errors.defaultCommission = 'A percentage from 0 to 50, with at most two decimals.';
  }

  const sortText = String(form.sortOrder ?? '').trim();
  const sortOrder = /^\d{1,4}$/.test(sortText) ? Number(sortText) : NaN;
  if (!(sortOrder >= 0 && sortOrder <= SORT_ORDER_MAX)) {
    errors.sortOrder = `A whole number from 0 to ${SORT_ORDER_MAX}.`;
  }

  if (Object.keys(errors).length) return { ok: false, errors };

  if (!original) {
    return {
      ok: true,
      body: {
        name,
        ...(slug !== '' && { slug }),
        ...(parentId && { parentId }),
        ...(commission !== null && { defaultCommissionBps: commission }),
        sortOrder,
        isActive: Boolean(form.isActive),
      },
    };
  }

  const body = {};
  if (name !== original.name) body.name = name;
  if ((parentId || null) !== (original.parentId ?? null)) body.parentId = parentId || null;
  if (commission !== (original.defaultCommissionBps ?? null))
    body.defaultCommissionBps = commission;
  if (sortOrder !== (original.sortOrder ?? 0)) body.sortOrder = sortOrder;
  if (Boolean(form.isActive) !== original.isActive) body.isActive = Boolean(form.isActive);
  if (Object.keys(body).length === 0) return { ok: false, errors: {}, unchanged: true };
  return { ok: true, body };
}

// ---- server errors ----

/**
 * An ApiError -> { fieldErrors: { name: message }, message }.
 * 422 details carry a path like "body.parentId"; a 409 is the unique-slug conflict.
 * `message` is what is left to show above the form when no field can take it.
 */
export function categoryErrors(error, { slugGiven = false } = {}) {
  const fieldErrors = {};
  if (error?.status === 422 && Array.isArray(error.details)) {
    for (const detail of error.details) {
      const field = String(detail?.path ?? '').replace(/^body\./, '');
      if (field && !field.includes('.') && !fieldErrors[field]) fieldErrors[field] = detail.message;
    }
    if (Object.keys(fieldErrors).length) return { fieldErrors, message: null };
  }
  if (error?.status === 409) {
    const field = slugGiven ? 'slug' : 'name';
    fieldErrors[field] = slugGiven
      ? 'Another category already uses this slug.'
      : 'Another category already has this name (its web address would clash). Choose a different name or enter a slug.';
    return { fieldErrors, message: null };
  }
  if (error?.status === 404) {
    return {
      fieldErrors,
      message: 'This category no longer exists. Close this window and reload the page.',
    };
  }
  return { fieldErrors, message: error?.message ?? 'Something went wrong.' };
}
