const ok = (res, data, status = 200, meta) =>
  res.status(status).json({ success: true, data, ...(meta && { meta }) });

export function createSettlementsController({ settlementsService, reconciliationService }) {
  return {
    async vendorList(req, res) {
      const { items, meta } = await settlementsService.listForVendor(
        req.vendor.id,
        req.valid.query,
      );
      ok(res, items, 200, meta);
    },
    async adminList(req, res) {
      const { items, meta } = await settlementsService.listForAdmin(req.valid.query);
      ok(res, items, 200, meta);
    },
    async adminRelease(req, res) {
      const s = await settlementsService.adminRelease(req.user, req.valid.params.settlementId);
      ok(res, {
        id: s.id,
        status: s.status,
        releasedAt: s.releasedAt,
        netPayoutPaise: s.netPayoutPaise,
      });
    },
    async reportsList(req, res) {
      const { items, meta } = await reconciliationService.list(req.valid.query);
      ok(res, items, 200, meta);
    },
    async reportRun(req, res) {
      ok(res, await reconciliationService.runForAdmin(req.user), 201);
    },
  };
}
