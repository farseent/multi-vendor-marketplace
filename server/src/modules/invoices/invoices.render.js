import PDFDocument from 'pdfkit';
import { formatPaise } from './invoices.view.js';

const MARGIN = 48;
// Column x positions and widths of the items table (A4 is 595pt wide: 48 + 499 + 48).
const COLS = {
  title: { x: MARGIN, width: 225 },
  qty: { x: 280, width: 30, align: 'right' },
  unit: { x: 315, width: 80, align: 'right' },
  discount: { x: 400, width: 65, align: 'right' },
  net: { x: 470, width: 77, align: 'right' },
};

/**
 * Draws the invoice view (see invoices.view.js) and resolves to the PDF as a Buffer. The whole
 * document is built in memory first, so a failure never leaves a half-sent download (D63).
 * Fonts are the built-in Helvetica family: Latin-1 only, which `pdfSafe` already guarantees.
 */
export function renderInvoicePdf(view) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      info: { Title: `Invoice ${view.invoiceNumber}`, Author: view.seller },
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      draw(doc, view);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

const date = (value) => new Date(value).toISOString().slice(0, 10);
const bottom = (doc) => doc.page.height - doc.page.margins.bottom - 40;

/** Starts a new page when fewer than `needed` points are left. */
function ensureRoom(doc, y, needed) {
  if (y + needed <= bottom(doc)) return y;
  doc.addPage();
  return MARGIN;
}

function cell(doc, text, col, y, font = 'Helvetica') {
  doc.font(font).fontSize(9).text(String(text), col.x, y, { width: col.width, align: col.align });
}

function itemsHeader(doc, y) {
  cell(doc, 'Item', COLS.title, y, 'Helvetica-Bold');
  cell(doc, 'Qty', COLS.qty, y, 'Helvetica-Bold');
  cell(doc, 'Unit price', COLS.unit, y, 'Helvetica-Bold');
  cell(doc, 'Discount', COLS.discount, y, 'Helvetica-Bold');
  cell(doc, 'Amount', COLS.net, y, 'Helvetica-Bold');
  doc
    .moveTo(MARGIN, y + 13)
    .lineTo(547, y + 13)
    .strokeColor('#999999')
    .stroke();
  return y + 18;
}

/** A label on the left and an amount on the right, e.g. "Shipping ........ INR 0.00". */
function totalLine(doc, y, label, paise, { bold = false } = {}) {
  const font = bold ? 'Helvetica-Bold' : 'Helvetica';
  doc.font(font).fontSize(10).text(label, 300, y, { width: 165 });
  doc.font(font).fontSize(10).text(formatPaise(paise), 470, y, { width: 77, align: 'right' });
  return y + 16;
}

function draw(doc, view) {
  doc.font('Helvetica-Bold').fontSize(20).text('Invoice', MARGIN, MARGIN);
  doc.font('Helvetica').fontSize(10);
  doc.text(view.seller, MARGIN, MARGIN + 28);
  doc.text(`Invoice no: ${view.invoiceNumber}`, 340, MARGIN, { width: 207, align: 'right' });
  doc.text(`Invoice date: ${date(view.issuedAt)}`, 340, MARGIN + 14, {
    width: 207,
    align: 'right',
  });
  doc.text(`Order: ${view.orderNumber}`, 340, MARGIN + 28, { width: 207, align: 'right' });
  doc.text(`Order date: ${date(view.orderPlacedAt)}`, 340, MARGIN + 42, {
    width: 207,
    align: 'right',
  });

  let y = MARGIN + 70;
  doc.font('Helvetica-Bold').text('Billed and shipped to', MARGIN, y);
  doc.font('Helvetica');
  for (const line of view.billTo) {
    y += 14;
    doc.text(line, MARGIN, y);
  }
  y += 30;

  // Every vendor's part of the order, one block each (acceptance: lists every vendor's items).
  for (const section of view.sections) {
    y = ensureRoom(doc, y, 90);
    doc.font('Helvetica-Bold').fontSize(11).text(`Sold by ${section.shopName}`, MARGIN, y);
    doc
      .font('Helvetica')
      .fontSize(9)
      .text(`${section.subOrderNumber} (${section.status})`, 300, y + 2, {
        width: 247,
        align: 'right',
      });
    y = itemsHeader(doc, y + 20);

    for (const item of section.items) {
      const label = `${item.title} (SKU ${item.sku})`;
      doc.font('Helvetica').fontSize(9);
      const height = Math.max(doc.heightOfString(label, { width: COLS.title.width }), 12);
      y = ensureRoom(doc, y, height + 6);
      cell(doc, label, COLS.title, y);
      cell(doc, item.quantity, COLS.qty, y);
      cell(doc, formatPaise(item.unitPricePaise), COLS.unit, y);
      cell(doc, item.discountPaise ? `-${formatPaise(item.discountPaise)}` : '-', COLS.discount, y);
      cell(doc, formatPaise(item.lineNetPaise), COLS.net, y);
      y += height + 6;
    }

    y = ensureRoom(doc, y, 70);
    y = totalLine(doc, y + 2, 'Seller total', section.customerTotalPaise);
    if (section.refundedPaise > 0) y = totalLine(doc, y, 'Refunded', -section.refundedPaise);
    y += 14;
  }

  // Order totals.
  y = ensureRoom(doc, y, 120);
  doc.moveTo(300, y).lineTo(547, y).strokeColor('#999999').stroke();
  y += 8;
  y = totalLine(doc, y, 'Subtotal', view.totals.subtotalPaise);
  if (view.totals.discountPaise > 0) {
    const label = view.coupon ? `Discount (${view.coupon.code})` : 'Discount';
    y = totalLine(doc, y, label, -view.totals.discountPaise);
  }
  y = totalLine(doc, y, 'Shipping', view.totals.shippingPaise);
  y = totalLine(doc, y, 'Total paid', view.totals.totalPaise, { bold: true });
  if (view.totals.refundedPaise > 0) {
    y = totalLine(doc, y, 'Refunded', -view.totals.refundedPaise);
    y = totalLine(doc, y, 'Net paid', view.totals.netPaidPaise, { bold: true });
  }

  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#666666')
    .text(
      'This is a payment record for your order, not a tax invoice. Amounts are in Indian rupees (INR).',
      MARGIN,
      Math.min(y + 24, bottom(doc)),
      { width: 499 },
    );
}
