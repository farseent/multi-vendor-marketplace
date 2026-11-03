import { SubOrder } from '../orders/orders.model.js';
import { readOptionalIdempotencyKey } from './refunds.validator.js';

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

export function createRefundsController({ refundsService, fulfillmentService }) {
  return {
    /** POST /admin/sub-orders/:subOrderId/refund: 201 first time, 200 for a repeated key. */
    async adminRefund(req, res) {
      const { subOrderId } = req.valid.params;
      const { replayed, refund } = await refundsService.adminRefund(
        req.user,
        subOrderId,
        req.valid.body,
        {
          idempotencyKey: readOptionalIdempotencyKey(req),
          cancel: fulfillmentService.cancelForAdmin,
        },
      );
      const sub = await SubOrder.findById(subOrderId);
      ok(
        res,
        {
          refund: refundsService.present(refund),
          subOrder: {
            id: sub.id,
            fulfillmentStatus: sub.fulfillmentStatus,
            refundStatus: sub.refundStatus,
            refundedPaise: sub.refundedPaise,
          },
        },
        replayed ? 200 : 201,
      );
    },
  };
}
