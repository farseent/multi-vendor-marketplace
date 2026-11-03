import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
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
import { formatINR } from '../lib/money.js';
import './orders.css';

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

  if (!order.payment) return <p role="status">Preparing your payment…</p>;
  const error = pay.error ?? verify.error;
  return (
    <div className="payment-panel">
      {remaining > 0 ? (
        <p>
          Complete your payment within <strong>{formatCountdown(remaining)}</strong>, or the items
          go back on sale.
        </p>
      ) : (
        <p role="status">
          The reservation has ended. If you have just paid, this page will update.
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{checkoutErrorMessage(error)}</p>}
      <button
        type="button"
        disabled={pay.isPending || remaining === 0}
        onClick={() => pay.mutate()}
      >
        {pay.isPending
          ? 'Processing…'
          : order.payment.provider === 'mock'
            ? `Simulate payment of ${formatINR(order.payment.amountPaise)} (development)`
            : `Pay ${formatINR(order.payment.amountPaise)}`}
      </button>
    </div>
  );
}

/** Cancel one seller's part of the order, until they ship it. The API refunds it in full. */
function CancelButton({ orderId, sub }) {
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => cancelSubOrder(orderId, sub.id),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: orderKey(orderId) });
      queryClient.invalidateQueries({ queryKey: ORDERS_KEY });
    },
  });
  return (
    <>
      {cancel.error && <p role="alert">{fulfillmentErrorMessage(cancel.error)}</p>}
      <button
        type="button"
        className="danger"
        disabled={cancel.isPending}
        onClick={() => {
          if (window.confirm('Cancel this part of your order? You will be refunded in full.')) {
            cancel.mutate();
          }
        }}
      >
        {cancel.isPending ? 'Cancelling…' : 'Cancel this part of the order'}
      </button>
    </>
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

  if (isPending) return <p>Loading…</p>;
  if (error) {
    return (
      <p role="alert">
        {error.status === 404 ? 'Order not found.' : error.message}{' '}
        <Link to="/orders">Your orders</Link>
      </p>
    );
  }

  return (
    <section>
      <p>
        <Link to="/orders">← Your orders</Link>
      </p>
      <h1>Order {order.orderNumber}</h1>
      <p className="order-status" role="status">
        {orderStatusLabel(order)}
      </p>

      {order.status === 'pending_payment' && (
        <PaymentPanel order={order} autoPay={Boolean(location.state?.autoPay)} />
      )}

      {order.subOrders.map((sub) => (
        <article key={sub.id} className="sub-order">
          <h2>
            {sub.shop?.name ?? 'Seller'} <small>{sub.subOrderNumber}</small>
          </h2>
          <p>
            Status: <strong>{sub.fulfillmentStatus.replaceAll('_', ' ')}</strong>
          </p>
          {sub.tracking && (
            <p>
              Tracking: {sub.tracking.carrier} {sub.tracking.trackingNumber}
            </p>
          )}
          {refundLine(sub) && <p role="status">{refundLine(sub)}</p>}
          {canCancelSubOrder(sub) && order.status === 'placed' && (
            <CancelButton orderId={order.id} sub={sub} />
          )}
          <ul className="cart-lines">
            {sub.items.map((item) => (
              <li key={item.productId} className="cart-line">
                {item.imageUrl && <img src={item.imageUrl} alt="" width="48" height="48" />}
                <div className="cart-line-info">
                  <span>{item.title}</span>
                  <small>
                    {item.quantity} × {formatINR(item.unitPricePaise)}
                  </small>
                </div>
                <strong>{formatINR(item.lineNetPaise)}</strong>
              </li>
            ))}
          </ul>
        </article>
      ))}

      <dl className="cart-totals">
        <dt>Subtotal</dt>
        <dd>{formatINR(order.subtotalPaise)}</dd>
        {order.discountPaise > 0 && (
          <>
            <dt>Discount{order.coupon ? ` (${order.coupon.code})` : ''}</dt>
            <dd>−{formatINR(order.discountPaise)}</dd>
          </>
        )}
        <dt>Shipping</dt>
        <dd>Free</dd>
        <dt>Total</dt>
        <dd>
          <strong>{formatINR(order.totalPaise)}</strong>
        </dd>
      </dl>

      <h2>Delivery address</h2>
      <address>
        {order.shippingAddress.name}
        <br />
        {order.shippingAddress.line1}
        <br />
        {order.shippingAddress.city}, {order.shippingAddress.state}{' '}
        {order.shippingAddress.postalCode}
      </address>
    </section>
  );
}
