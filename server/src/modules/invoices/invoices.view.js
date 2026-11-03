import { INVOICE } from '../../config/constants.js';

// Pure functions: order data in, a plain "what goes on the page" object out. No database, no PDF
// library, so every number on the invoice can be unit-tested.

const rupees = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** 149950 -> "INR 1,499.50". The standard PDF fonts have no rupee sign, so the code is spelled out. */
export function formatPaise(paise) {
  if (!Number.isSafeInteger(paise)) throw new RangeError('Expected integer paise');
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  // Rupees and paise are formatted separately: no division into a float (D5).
  return `${sign}INR ${rupees.format(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * The built-in PDF fonts only cover Latin-1. Anything else (Devanagari, emoji...) would print as
 * garbage, so it becomes "?" (D63). Newlines and tabs become spaces, so one value stays one line.
 */
export function pdfSafe(value) {
  return String(value ?? '')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
    .trim();
}

export const invoiceNumberFor = (year, seq) =>
  `${INVOICE.numberPrefix}-${year}-${String(seq).padStart(6, '0')}`;

/**
 * @param order     the paid Order
 * @param subOrders every sub-order of that order (all vendors)
 * @param shopsById Map of vendorId string -> vendor document (for the shop name)
 * @param invoice   { invoiceNumber, generatedAt }
 */
export function buildInvoiceView({ order, subOrders, shopsById, invoice }) {
  const address = order.shippingAddress ?? {};
  const sections = subOrders.map((sub) => ({
    shopName: pdfSafe(shopsById.get(String(sub.vendorId))?.shopName ?? 'Seller'),
    subOrderNumber: sub.subOrderNumber,
    status: sub.fulfillmentStatus.replaceAll('_', ' '),
    items: sub.items.map((item) => ({
      title: pdfSafe(item.title),
      sku: pdfSafe(item.sku),
      quantity: item.quantity,
      unitPricePaise: item.unitPricePaise,
      discountPaise: item.discountPaise,
      lineNetPaise: item.lineNetPaise,
    })),
    subtotalPaise: sub.subtotalPaise,
    discountPaise: sub.discountPaise,
    shippingPaise: sub.shippingPaise,
    customerTotalPaise: sub.customerTotalPaise,
    refundedPaise: sub.refundedPaise ?? 0,
  }));
  const refundedPaise = sections.reduce((sum, s) => sum + s.refundedPaise, 0);

  return {
    seller: INVOICE.platformName,
    invoiceNumber: invoice.invoiceNumber,
    issuedAt: invoice.generatedAt,
    orderNumber: order.orderNumber,
    orderPlacedAt: order.placedAt ?? order.createdAt,
    currency: order.currency,
    billTo: [
      pdfSafe(address.name),
      pdfSafe([address.line1, address.line2].filter(Boolean).join(', ')),
      pdfSafe(`${address.city ?? ''}, ${address.state ?? ''} ${address.postalCode ?? ''}`),
      pdfSafe(address.phone),
    ].filter((line) => line && line !== ','),
    coupon: order.coupon
      ? { code: pdfSafe(order.coupon.code), discountPaise: order.coupon.discountPaise }
      : null,
    sections,
    totals: {
      subtotalPaise: order.subtotalPaise,
      discountPaise: order.discountPaise,
      shippingPaise: order.shippingPaise,
      totalPaise: order.totalPaise,
      refundedPaise,
      netPaidPaise: order.totalPaise - refundedPaise,
    },
  };
}
