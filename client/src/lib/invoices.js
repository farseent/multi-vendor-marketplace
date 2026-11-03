import { apiDownload } from './api.js';

// Invoice download (Phase 7). The API decides who may download; this only decides whether to show
// the button, and turns the PDF bytes into a saved file.

/** An invoice exists only once the order is paid (API_CONTRACTS). */
export const canDownloadInvoice = (order) => order.paymentStatus === 'paid';

/** "attachment; filename=\"INV-2026-000001.pdf\"" -> "INV-2026-000001.pdf". */
export function invoiceFilename(contentDisposition, fallback = 'invoice.pdf') {
  const match = /filename="([A-Za-z0-9][A-Za-z0-9._-]*)"/.exec(contentDisposition ?? '');
  return match ? match[1] : fallback;
}

export function invoiceErrorMessage(error) {
  if (error?.status === 404) return 'Order not found.';
  if (error?.details?.reason === 'order_not_paid') {
    return 'The invoice is available once the order is paid.';
  }
  return error?.message ?? 'Could not download the invoice.';
}

/** Fetches the PDF and saves it through a temporary link. Resolves to the file name. */
export async function downloadInvoice(orderId) {
  const { blob, contentDisposition } = await apiDownload(`/orders/${orderId}/invoice`);
  const filename = invoiceFilename(contentDisposition);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return filename;
}
