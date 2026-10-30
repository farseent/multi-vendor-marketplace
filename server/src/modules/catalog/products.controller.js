const ok = (res, data, status = 200, meta) =>
  res.status(status).json({ success: true, data, ...(meta && { meta }) });

// req.vendor is set by the loadShop middleware (vendor routes only).
export function createProductsController({ productsService }) {
  return {
    async getPublic(req, res) {
      ok(res, await productsService.getPublicBySlug(req.valid.params.slug));
    },
    async create(req, res) {
      ok(res, await productsService.create(req.vendor, req.valid.body), 201);
    },
    async list(req, res) {
      const { items, meta } = await productsService.list(req.vendor.id, req.valid.query);
      ok(res, items, 200, meta);
    },
    async get(req, res) {
      ok(res, await productsService.getOwn(req.vendor.id, req.valid.params.productId));
    },
    async update(req, res) {
      const { productId } = req.valid.params;
      ok(res, await productsService.update(req.vendor, productId, req.valid.body));
    },
    async archive(req, res) {
      ok(res, await productsService.archive(req.vendor.id, req.valid.params.productId));
    },
    async setStock(req, res) {
      const { productId } = req.valid.params;
      ok(res, await productsService.setStock(req.vendor.id, productId, req.valid.body.stockQty));
    },
  };
}
