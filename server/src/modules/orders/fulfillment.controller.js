const ok = (res, data, status = 200, meta) =>
  res.status(status).json({ success: true, data, ...(meta && { meta }) });

// Vendor handlers read req.vendor (set by loadShop); the customer handler reads req.user.
export function createFulfillmentController({ fulfillmentService, ordersService }) {
  return {
    async vendorList(req, res) {
      const { items, meta } = await fulfillmentService.listForVendor(req.vendor, req.valid.query);
      ok(res, items, 200, meta);
    },
    async vendorGet(req, res) {
      ok(res, await fulfillmentService.getForVendor(req.vendor, req.valid.params.subOrderId));
    },
    async vendorUpdateStatus(req, res) {
      ok(
        res,
        await fulfillmentService.updateStatus(
          req.vendor,
          req.user,
          req.valid.params.subOrderId,
          req.valid.body,
        ),
      );
    },
    async customerCancel(req, res) {
      const { orderId } = req.valid.params;
      const { refundId } = await fulfillmentService.cancelForCustomer(req.user, req.valid.params);
      ok(res, { refundId, order: await ordersService.get(req.user.id, orderId) });
    },
  };
}
