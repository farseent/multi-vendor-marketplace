import { apiFetch } from './api.js';
import { formatINR } from './money.js';

// Fulfilment, refunds and settlements, seen from the vendor and the customer (Phase 6).
// The API decides what is allowed; these helpers only decide which buttons to SHOW.

export const VENDOR_SUB_ORDERS_KEY = ['vendor-sub-orders'];
export const VENDOR_SETTLEMENTS_KEY = ['vendor-settlements'];

export const fetchVendorSubOrders = async (fulfillmentStatus) =>
  (
    await apiFetch(
      `/vendor/sub-orders?limit=50${fulfillmentStatus ? `&fulfillmentStatus=${fulfillmentStatus}` : ''}`,
    )
  ).data;

export const updateSubOrderStatus = (subOrderId, body) =>
  apiFetch(`/vendor/sub-orders/${subOrderId}/status`, { method: 'PATCH', body });

export const fetchVendorSettlements = async () =>
  (await apiFetch('/vendor/settlements?limit=50')).data;

export const cancelSubOrder = (orderId, subOrderId) =>
  apiFetch(`/orders/${orderId}/sub-orders/${subOrderId}/cancel`, { method: 'POST', body: {} });

/** The customer may cancel only before the seller ships. */
export const canCancelSubOrder = (sub) => sub.fulfillmentStatus === 'processing';

/** What a vendor can do with a sub-order next: the same table the API enforces. */
export function vendorActions(fulfillmentStatus) {
  if (fulfillmentStatus === 'processing') return ['ship', 'cancel'];
  if (fulfillmentStatus === 'shipped') return ['deliver'];
  return [];
}

/** "Refunded ₹300.00 of ₹500.00", "Refund on its way", or null when nothing was refunded. */
export function refundLine(sub) {
  if (sub.refundStatus === 'pending') return 'Refund on its way';
  if (sub.refundStatus === 'failed') return 'Refund problem: our team has been alerted';
  if (!sub.refundedPaise) return null;
  return sub.refundStatus === 'full'
    ? `Refunded in full (${formatINR(sub.refundedPaise)})`
    : `Refunded ${formatINR(sub.refundedPaise)} of ${formatINR(sub.customerTotalPaise)}`;
}

const SETTLEMENT_LABELS = {
  not_eligible: 'Not yet payable (until delivered)',
  pending_release: 'Waiting for the return window to end',
  released: 'Released, on its way to your bank',
  settled: 'Paid out',
  reversed: 'Cancelled (refunded in full)',
  failed: 'Failed, contact support',
};
export const settlementStatusLabel = (status) => SETTLEMENT_LABELS[status] ?? status;

export function fulfillmentErrorMessage(error) {
  switch (error?.code) {
    case 'INVALID_STATE_TRANSITION':
      return 'This order has already moved on. Refresh to see its current status.';
    case 'VENDOR_NOT_APPROVED':
      return 'Your shop must be approved before you can fulfil orders.';
    case 'NOT_FOUND':
      return 'Order not found.';
    case 'NETWORK_ERROR':
      return 'Cannot reach the server. Check your connection and try again.';
    default:
      return error?.message ?? 'Something went wrong.';
  }
}
