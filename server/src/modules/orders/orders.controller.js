import { readIdempotencyKey } from './orders.validator.js';

const ok = (res, data, status = 200, meta) =>
  res.status(status).json({ success: true, data, ...(meta && { meta }) });

// Every handler acts on req.user.id: a customer can only ever reach their own orders.
export function createOrdersController({ checkoutService, ordersService }) {
  return {
    async checkout(req, res) {
      const idempotencyKey = readIdempotencyKey(req);
      const { replayed, data } = await checkoutService.checkout(req.user.id, {
        idempotencyKey,
        ...req.valid.body,
      });
      ok(res, data, replayed ? 200 : 201);
    },
    async list(req, res) {
      const { items, meta } = await ordersService.list(req.user.id, req.valid.query);
      ok(res, items, 200, meta);
    },
    async get(req, res) {
      ok(res, await ordersService.get(req.user.id, req.valid.params.orderId));
    },
  };
}
