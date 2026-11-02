import { AppError } from '../../lib/AppError.js';

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

export function createPaymentsController({ paymentsService, webhooksService, paymentProvider }) {
  return {
    async verify(req, res) {
      ok(res, await paymentsService.verify(req.user.id, req.valid.body));
    },
    async mockComplete(req, res) {
      ok(res, await paymentsService.mockComplete(req.user.id, req.valid.body.orderId));
    },

    /**
     * POST /webhooks/razorpay. `req.body` is the RAW Buffer (express.raw is mounted before the
     * JSON parser): the signature is computed over exactly those bytes (D46). Always 200 for a
     * correctly signed request, including duplicates and events we ignore.
     */
    async razorpayWebhook(req, res) {
      const raw = req.body;
      if (
        !Buffer.isBuffer(raw) ||
        !paymentProvider.verifyWebhookSignature(raw, req.get('x-razorpay-signature'))
      ) {
        throw new AppError('INVALID_WEBHOOK_SIGNATURE', 400, 'Invalid webhook signature');
      }
      let body;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new AppError('BAD_REQUEST', 400, 'Malformed JSON body');
      }
      const eventId = req.get('x-razorpay-event-id');
      if (!eventId || typeof body?.event !== 'string') {
        throw new AppError('BAD_REQUEST', 400, 'Missing event id or event type');
      }
      await webhooksService.receive({ eventId, eventType: body.event, body });
      ok(res, { received: true });
    },
  };
}
