import { AppError } from '../../lib/AppError.js';
import { Counter, Order, SubOrder } from '../orders/orders.model.js';
import { Vendor } from '../shops/shops.model.js';
import { Invoice } from './invoices.model.js';
import { renderInvoicePdf } from './invoices.render.js';
import { buildInvoiceView, invoiceNumberFor } from './invoices.view.js';

/**
 * Invoices (D63). The PDF is built on demand from the order; only the invoice NUMBER is stored,
 * so repeated downloads show the same number while refunds made later still appear on the page.
 * `render` is injectable so tests can replace the PDF library.
 */
export function createInvoicesService({ render = renderInvoicePdf } = {}) {
  /**
   * Next number of the year from the `counters` collection ($inc upsert, like order numbers).
   * Gap-tolerant: a number taken by a request that then lost a race (see ensureInvoice) is simply
   * never used. Unique always, because the increment is atomic.
   */
  async function nextInvoiceNumber(at) {
    const year = at.getUTCFullYear();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const counter = await Counter.findOneAndUpdate(
          { _id: `invoice:${year}` },
          { $inc: { seq: 1 } },
          { upsert: true, returnDocument: 'after' },
        );
        return invoiceNumberFor(year, counter.seq);
      } catch (err) {
        if (err?.code !== 11000) throw err; // two first-of-the-year upserts collided: try again
      }
    }
    throw new AppError('CONFLICT', 409, 'Could not allocate an invoice number, please retry');
  }

  /** The order's invoice record: created once, then always the same one (unique orderId). */
  async function ensureInvoice(order) {
    const existing = await Invoice.findOne({ orderId: order._id });
    if (existing) return existing;
    const generatedAt = new Date();
    const invoiceNumber = await nextInvoiceNumber(generatedAt);
    try {
      return await Invoice.create({ orderId: order._id, invoiceNumber, generatedAt });
    } catch (err) {
      if (err?.code === 11000) {
        // Another request created this order's invoice first: use theirs, drop our number.
        const winner = await Invoice.findOne({ orderId: order._id });
        if (winner) return winner;
      }
      throw err;
    }
  }

  return {
    ensureInvoice,

    /**
     * The invoice PDF of the caller's own PAID order. Another customer's order is a 404 (D15);
     * an unpaid, expired or failed order has no invoice (409).
     */
    async generate(customerId, orderId) {
      const order = await Order.findOne({ _id: orderId, customerId });
      if (!order) throw new AppError('NOT_FOUND', 404, 'Order not found');
      if (order.paymentStatus !== 'paid') {
        throw new AppError('CONFLICT', 409, 'An invoice is available once the order is paid', {
          reason: 'order_not_paid',
        });
      }

      const invoice = await ensureInvoice(order);
      const subOrders = await SubOrder.find({ orderId: order._id }).sort({ subOrderNumber: 1 });
      const shops = await Vendor.find({ _id: { $in: subOrders.map((s) => s.vendorId) } });
      const shopsById = new Map(shops.map((s) => [s.id, s]));

      const view = buildInvoiceView({ order, subOrders, shopsById, invoice });
      const pdf = await render(view);
      return {
        invoiceNumber: invoice.invoiceNumber,
        filename: `${invoice.invoiceNumber}.pdf`,
        pdf,
      };
    },
  };
}
