import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { Alert, Button, Card, CardHeader, ConfirmDialog, Container, ErrorState, Icon, LinkButton, OrderTotals, PageHeader, PageLoading, StatusBadge } from '../components/ui';
import { apiFetch } from '../lib/api.js';
import {
  buildCheckoutOptions,
  checkoutErrorMessage,
  fetchOrder,
  formatCountdown,
  loadRazorpayCheckout,
  orderKey,
  ORDERS_KEY,
  orderStatusLabel,
  secondsLeft,
  toVerifyBody,
} from '../lib/checkout.js';
import {
  cancelSubOrder,
  canCancelSubOrder,
  fulfillmentErrorMessage,
  refundLine,
} from '../lib/fulfillment.js';
import { canDownloadInvoice, downloadInvoice, invoiceErrorMessage } from '../lib/invoices.js';
import { formatINR } from '../lib/money.js';

/** Counts down to the end of the 15-minute stock reservation. */
function useCountdown(expiresAt) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return secondsLeft(expiresAt, now);
}

/** Pay for an unpaid order: Razorpay Checkout, or the development mock when the API runs the mock ledger. */
function PaymentPanel({ order, autoPay }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const remaining = useCountdown(order.reservationExpiresAt);
  const [notice, setNotice] = useState(null);
  const startedAuto = useRef(false);

  const verify = useMutation({
    mutationFn: (response) =>
      apiFetch('/payments/verify', { method: 'POST', body: toVerifyBody(order.id, response) }),
    onSuccess: ({ data }) => {
      queryClient.invalidateQueries({ queryKey: orderKey(order.id) });
      queryClient.invalidateQueries({ queryKey: ORDERS_KEY });
      if (data.status === 'pending_payment') {
        setNotice('Payment received by your bank, waiting for confirmation…');
      }
    },
  });

  const pay = useMutation({
    mutationFn: async () => {
      if (order.payment.provider === 'mock') {
        const { data } = await apiFetch('/payments/mock/complete', {
          method: 'POST',
          body: { orderId: order.id },
        });
        return verify.mutateAsync(data);
      }
      const Razorpay = await loadRazorpayCheckout();
      return new Promise((resolve, reject) => {
        const widget = new Razorpay(
          buildCheckoutOptions({
            payment: order.payment,
            order,
            user,
            onPaid: (response) => verify.mutateAsync(response).then(resolve, reject),
            onDismiss: () => resolve(null), // closed the window without paying
          }),
        );
        widget.open();
      });
    },
  });

  // Right after placing the order, open the payment window once (real provider only: the mock
  // keeps an explicit button so the flow can be demonstrated step by step).
  useEffect(() => {
    if (autoPay && !startedAuto.current && order.payment?.provider !== 'mock' && remaining > 0) {
      startedAuto.current = true;
      pay.mutate();
    }
  }, [autoPay, order.payment, remaining, pay]);

  if (!order.payment) return <Alert tone="info">Preparing your payment…</Alert>;
  const error = pay.error ?? verify.error;
  return (
    <Card className="border-brand-200 bg-brand-50/50">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <Icon name="credit-card" className="text-brand-600" />
            Complete your payment
          </h2>
          {remaining > 0 ? (
            <p className="mt-1 text-sm text-slate-600">
              Pay within{' '}
              <strong className="tabular text-slate-900">{formatCountdown(remaining)}</strong>, or
              the items go back on sale.
            </p>
          ) : (
            <p role="status" className="mt-1 text-sm text-slate-600">
              The reservation has ended. If you have just paid, this page will update.
            </p>
          )}
        </div>
        <Button size="lg" wrap className="w-full sm:w-auto" disabled={remaining === 0} loading={pay.isPending} onClick={() => pay.mutate()}>
          {pay.isPending
            ? 'Processing…'
            : order.payment.provider === 'mock'
              ? `Simulate payment of ${formatINR(order.payment.amountPaise)} (development)`
              : `Pay ${formatINR(order.payment.amountPaise)}`}
        </Button>
      </div>
      <div className="mt-3 space-y-3 empty:hidden">
        {notice && <Alert tone="info">{notice}</Alert>}
        {error && <Alert tone="danger">{checkoutErrorMessage(error)}</Alert>}
      </div>
    </Card>
  );
}

/** Cancel one seller's part of the order, until they ship it. The API refunds it in full. */
function CancelButton({ orderId, sub }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const cancel = useMutation({
    mutationFn: () => cancelSubOrder(orderId, sub.id),
    onSettled: () => {
      setConfirming(false);
      queryClient.invalidateQueries({ queryKey: orderKey(orderId) });
      queryClient.invalidateQueries({ queryKey: ORDERS_KEY });
    },
  });
  return (
    <>
      {cancel.error && <Alert tone="danger">{fulfillmentErrorMessage(cancel.error)}</Alert>}
      <Button variant="danger-outline" size="sm" onClick={() => setConfirming(true)}>
        Cancel this part of the order
      </Button>
      <ConfirmDialog
        open={confirming}
        title="Cancel this part of your order?"
        message="You will be refunded in full."
        confirmLabel="Cancel this part"
        cancelLabel="Keep it"
        pending={cancel.isPending}
        onConfirm={() => cancel.mutate()}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

/** Saves the invoice PDF. The button only shows for paid orders; the API checks again. */
function InvoiceButton({ orderId }) {
  const download = useMutation({ mutationFn: () => downloadInvoice(orderId) });
  return (
    <div className="space-y-2">
      <Button variant="secondary" className="w-full" loading={download.isPending} onClick={() => download.mutate()}>
        <Icon name="download" className="size-4" />
        {download.isPending ? 'Preparing invoice…' : 'Download invoice (PDF)'}
      </Button>
      {download.error && <Alert tone="danger">{invoiceErrorMessage(download.error)}</Alert>}
    </div>
  );
}

/** One order: status, items per seller, totals, and the payment step while it is unpaid. */
export default function OrderPage() {
  const { orderId } = useParams();
  const location = useLocation();
  const {
    data: order,
    error,
    isPending,
  } = useQuery({
    queryKey: orderKey(orderId),
    queryFn: () => fetchOrder(orderId),
    // While unpaid the webhook may confirm the payment at any moment: keep looking.
    refetchInterval: (query) => (query.state.data?.status === 'pending_payment' ? 5000 : false),
  });

  if (isPending) return <PageLoading />;
  if (error) {
    return (
      <Container narrow className="py-12">
        <ErrorState
          title={error.status === 404 ? 'Order not found' : 'We could not load this order'}
          message={error.status === 404 ? undefined : error.message}
          action={<LinkButton to="/orders">Your orders</LinkButton>}
        />
      </Container>
    );
  }

  return (
    <Container className="py-8 sm:py-10">
      <PageHeader
        back={{ to: '/orders', label: 'Your orders' }}
        title={`Order ${order.orderNumber}`}
        actions={
          <span role="status">
            <StatusBadge status={order.status} label={orderStatusLabel(order)} className="px-3 py-1 text-sm" />
          </span>
        }
      />

      {order.status === 'pending_payment' && (
        <div className="mb-6">
          <PaymentPanel order={order} autoPay={Boolean(location.state?.autoPay)} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div className="space-y-6">
          {order.subOrders.map((sub) => {
            const refund = refundLine(sub);
            return (
              <Card as="article" key={sub.id} padded={false}>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
                  <div className="min-w-0">
                    <h2 className="flex items-center gap-2 font-semibold text-slate-900">
                      <Icon name="store" className="size-4.5 text-slate-400" />
                      {sub.shop?.name ?? 'Seller'}
                    </h2>
                    <p className="text-xs text-slate-500">{sub.subOrderNumber}</p>
                  </div>
                  <StatusBadge status={sub.fulfillmentStatus} />
                </div>
                <div className="space-y-3 px-5 py-4 empty:hidden">
                  {sub.tracking && (
                    <p className="flex items-center gap-2 text-sm text-slate-700">
                      <Icon name="truck" className="size-4.5 text-slate-400" />
                      <span>
                        Tracking: <strong>{sub.tracking.carrier}</strong> {sub.tracking.trackingNumber}
                      </span>
                    </p>
                  )}
                  {refund && <Alert tone="info">{refund}</Alert>}
                  {canCancelSubOrder(sub) && order.status === 'placed' && (
                    <CancelButton orderId={order.id} sub={sub} />
                  )}
                </div>
                <ul className="divide-y divide-slate-100 border-t border-slate-100">
                  {sub.items.map((item) => (
                    <li key={item.productId} className="flex items-center gap-4 px-5 py-4">
                      <div className="size-14 shrink-0 overflow-hidden rounded-lg bg-slate-100">
                        {item.imageUrl && <img src={item.imageUrl} alt="" className="size-full object-cover" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 text-sm font-medium text-slate-900">{item.title}</p>
                        <p className="tabular text-xs text-slate-500">
                          {item.quantity} × {formatINR(item.unitPricePaise)}
                        </p>
                      </div>
                      <p className="tabular text-sm font-semibold text-slate-900">{formatINR(item.lineNetPaise)}</p>
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>

        <div className="space-y-6 lg:sticky lg:top-24">
          <Card>
            <CardHeader title="Payment summary" />
            <OrderTotals
              rows={[
                ['Subtotal', formatINR(order.subtotalPaise)],
                ...(order.discountPaise > 0
                  ? [[`Discount${order.coupon ? ` (${order.coupon.code})` : ''}`, `\u2212${formatINR(order.discountPaise)}`, 'success']]
                  : []),
                ['Shipping', 'Free'],
              ]}
              total={formatINR(order.totalPaise)}
            />
            {canDownloadInvoice(order) && (
              <div className="mt-5">
                <InvoiceButton orderId={order.id} />
              </div>
            )}
          </Card>
          <Card>
            <CardHeader title="Delivery address" />
            <address className="flex gap-3 text-sm not-italic text-slate-700">
              <Icon name="map-pin" className="mt-0.5 size-4.5 text-slate-400" />
              <span>
                <strong className="text-slate-900">{order.shippingAddress.name}</strong>
                <br />
                {order.shippingAddress.line1}
                <br />
                {order.shippingAddress.city}, {order.shippingAddress.state} {order.shippingAddress.postalCode}
              </span>
            </address>
          </Card>
        </div>
      </div>
    </Container>
  );
}