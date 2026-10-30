const ok = (res, data, status = 200, meta) =>
  res.status(status).json({ success: true, data, ...(meta && { meta }) });

export function createShopsController({ shopsService }) {
  return {
    async getOwn(req, res) {
      ok(res, await shopsService.getOwn(req.user.id));
    },
    async createOwn(req, res) {
      ok(res, await shopsService.createOwn(req.user.id, req.valid.body), 201);
    },
    async updateOwn(req, res) {
      ok(res, await shopsService.updateOwn(req.user.id, req.valid.body));
    },
    async getPublic(req, res) {
      ok(res, await shopsService.getPublicBySlug(req.valid.params.shopSlug));
    },
    async listVendors(req, res) {
      const { items, meta } = await shopsService.listForAdmin(req.valid.query);
      ok(res, items, 200, meta);
    },
    async setStatus(req, res) {
      const { vendorId } = req.valid.params;
      ok(res, await shopsService.setStatus(req.user, vendorId, req.valid.body.status));
    },
    async setCommission(req, res) {
      const { vendorId } = req.valid.params;
      ok(
        res,
        await shopsService.setCommission(req.user, vendorId, req.valid.body.commissionRateBps),
      );
    },
  };
}
