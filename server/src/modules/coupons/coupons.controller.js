const ok = (res, data, status = 200, meta) =>
  res.status(status).json({ success: true, data, ...(meta && { meta }) });

// Vendor handlers read req.vendor (set by loadShop); admin handlers read req.user.
export function createCouponsController({ couponsService }) {
  return {
    async vendorList(req, res) {
      const { items, meta } = await couponsService.listForVendor(req.vendor, req.valid.query);
      ok(res, items, 200, meta);
    },
    async vendorGet(req, res) {
      ok(res, await couponsService.getForVendor(req.vendor, req.valid.params.couponId));
    },
    async vendorCreate(req, res) {
      ok(res, await couponsService.createForVendor(req.vendor, req.valid.body), 201);
    },
    async vendorUpdate(req, res) {
      const { couponId } = req.valid.params;
      ok(res, await couponsService.updateForVendor(req.vendor, couponId, req.valid.body));
    },

    async adminList(req, res) {
      const { items, meta } = await couponsService.listForAdmin(req.valid.query);
      ok(res, items, 200, meta);
    },
    async adminGet(req, res) {
      ok(res, await couponsService.getForAdmin(req.valid.params.couponId));
    },
    async adminCreate(req, res) {
      ok(res, await couponsService.createForAdmin(req.user, req.valid.body), 201);
    },
    async adminUpdate(req, res) {
      const { couponId } = req.valid.params;
      ok(res, await couponsService.updateForAdmin(req.user, couponId, req.valid.body));
    },
  };
}
