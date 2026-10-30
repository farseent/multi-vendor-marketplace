const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

export function createCategoriesController({ categoriesService }) {
  return {
    async tree(_req, res) {
      ok(res, await categoriesService.tree());
    },
    async listAll(_req, res) {
      ok(res, await categoriesService.listAll());
    },
    async create(req, res) {
      ok(res, await categoriesService.create(req.user, req.valid.body), 201);
    },
    async update(req, res) {
      const { categoryId } = req.valid.params;
      ok(res, await categoriesService.update(req.user, categoryId, req.valid.body));
    },
  };
}
