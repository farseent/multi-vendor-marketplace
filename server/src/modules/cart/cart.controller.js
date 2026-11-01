const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// Every handler acts on req.user.id: a customer can only ever reach their own cart.
export function createCartController({ cartService }) {
  return {
    async get(req, res) {
      ok(res, await cartService.preview(req.user.id));
    },
    async setQuantity(req, res) {
      const { productId } = req.valid.params;
      ok(res, await cartService.setQuantity(req.user.id, productId, req.valid.body.quantity));
    },
    async removeItem(req, res) {
      ok(res, await cartService.removeItem(req.user.id, req.valid.params.productId));
    },
    async clear(req, res) {
      ok(res, await cartService.clear(req.user.id));
    },
    async applyCoupon(req, res) {
      ok(res, await cartService.applyCoupon(req.user.id, req.valid.body.code));
    },
    async removeCoupon(req, res) {
      ok(res, await cartService.removeCoupon(req.user.id));
    },
  };
}
