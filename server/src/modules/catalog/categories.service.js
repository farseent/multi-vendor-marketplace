import { AppError } from '../../lib/AppError.js';
import { slugify } from '../../lib/slug.js';
import { Category } from './categories.model.js';

const byOrder = (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
const invalidParent = (message) =>
  new AppError('VALIDATION_ERROR', 422, 'Invalid request', [{ path: 'body.parentId', message }]);

export function createCategoriesService({ audit }) {
  /** Two levels at most (DATABASE_SCHEMA): a parent must itself be a top-level category. */
  async function checkParent(parentId, selfId) {
    if (selfId && String(parentId) === String(selfId)) {
      throw invalidParent('A category cannot be its own parent');
    }
    const parent = await Category.findById(parentId);
    if (!parent) throw invalidParent('Parent category not found');
    if (parent.parentId) throw invalidParent('Categories can be nested only two levels deep');
  }

  return {
    /** Public tree of active categories: [{ id, name, slug, children: [...] }] */
    async tree() {
      const all = await Category.find({ isActive: true });
      const toNode = (c) => ({ id: c.id, name: c.name, slug: c.slug });
      const roots = all.filter((c) => !c.parentId).sort(byOrder);
      return roots.map((root) => ({
        ...toNode(root),
        children: all
          .filter((c) => c.parentId && String(c.parentId) === root.id)
          .sort(byOrder)
          .map(toNode),
      }));
    },

    /** Admin view: flat, includes inactive categories. */
    async listAll() {
      return (await Category.find()).sort(byOrder);
    },

    async create(actor, data) {
      if (data.parentId) await checkParent(data.parentId);
      // A duplicate slug surfaces as Mongo 11000, which the error handler maps to 409.
      const category = await Category.create({ ...data, slug: data.slug ?? slugify(data.name) });
      await audit.record(actor, {
        action: 'category.created',
        entityType: 'category',
        entityId: category._id,
      });
      return category;
    },

    async update(actor, categoryId, patch) {
      const category = await Category.findById(categoryId);
      if (!category) throw new AppError('NOT_FOUND', 404, 'Category not found');

      if (patch.parentId) {
        await checkParent(patch.parentId, category.id);
        // A category that already has children cannot become a child itself.
        if (await Category.exists({ parentId: category._id })) {
          throw invalidParent('A category with sub-categories cannot be nested under another');
        }
      }
      category.set(patch);
      await category.save();
      await audit.record(actor, {
        action: 'category.updated',
        entityType: 'category',
        entityId: category._id,
        meta: { fields: Object.keys(patch) },
      });
      return category;
    },
  };
}
