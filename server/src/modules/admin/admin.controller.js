const ok = (res, data, status = 200, meta) =>
  res.status(status).json({ success: true, data, ...(meta && { meta }) });

export function createAdminController({ adminService, analyticsService }) {
  return {
    async listProducts(req, res) {
      const { items, meta } = await adminService.listProducts(req.valid.query);
      ok(res, items, 200, meta);
    },
    async setProductStatus(req, res) {
      const { productId } = req.valid.params;
      ok(res, await adminService.setProductStatus(req.user, productId, req.valid.body.status));
    },
    async listReviews(req, res) {
      const { items, meta } = await adminService.listReviews(req.valid.query);
      ok(res, items, 200, meta);
    },
    async listOrders(req, res) {
      const { items, meta } = await adminService.listOrders(req.valid.query);
      ok(res, items, 200, meta);
    },
    async getOrder(req, res) {
      ok(res, await adminService.getOrder(req.valid.params.orderId));
    },
    async overview(req, res) {
      ok(res, await analyticsService.overview(req.valid.query));
    },
    async salesTimeseries(req, res) {
      ok(res, await analyticsService.salesTimeseries(req.valid.query));
    },
    async topVendors(req, res) {
      ok(res, await analyticsService.topVendors(req.valid.query));
    },
    async topProducts(req, res) {
      ok(res, await analyticsService.topProducts(req.valid.query));
    },
  };
}
