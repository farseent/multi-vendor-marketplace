import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  adminErrorMessage,
  adminGet,
  adminKey,
  adminSend,
  refundRequest,
  settlementStatusText,
} from '../lib/admin.js';
import { formatINR } from '../lib/money.js';
import { useAdminAction } from './hooks.js';

function RefundForm({ sub }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState(null);
  // One key per intended refund: a double click or a retry after a timeout is the SAME request.
  const key = useRef(crypto.randomUUID());
  const refund = useAdminAction((body) =>
    adminSend(`sub-orders/${sub.id}/refund`, 'POST', body, { 'Idempotency-Key': key.current }),
  );

  return (
    <form
      className="admin-filters"
      onSubmit={(e) => {
        e.preventDefault();
        const request = refundRequest({ amount, note, refundablePaise: sub.refundablePaise });
        setMessage(request.ok ? null : request.message);
        if (!request.ok) return;
        refund.mutate(request.body, {
          onSuccess: () => {
            key.current = crypto.randomUUID();
            setAmount('');
            setNote('');
          },
        });
      }}
    >
      <label>
        Amount (₹, empty = all {formatINR(sub.refundablePaise)})
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
      </label>
      <label>
        Note
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={300}
          required
          minLength={3}
        />
      </label>
      <button type="submit" disabled={refund.isPending}>
        Refund customer
      </button>
      {(message || refund.error) && (
        <span role="alert" className="error">
          {message ?? adminErrorMessage(refund.error)}
        </span>
      )}
    </form>
  );
}

function ReleaseButton({ settlement }) {
  const release = useAdminAction(() => adminSend(`settlements/${settlement.id}/release`, 'POST'));
  return (
    <>
      <button
        type="button"
        disabled={release.isPending}
        onClick={() => {
          if (window.confirm('Release this payout now, before the 7-day return window ends?'))
            release.mutate();
        }}
      >
        Release payout early
      </button>
      {release.error && (
        <span role="alert" className="error">
          {' '}
          {adminErrorMessage(release.error)}
        </span>
      )}
    </>
  );
}

function SubOrder({ sub }) {
  return (
    <article className="sub-order">
      <h3>
        {sub.subOrderNumber} · {sub.shop.name} ·{' '}
        <span className="badge">{sub.fulfillmentStatus}</span>
      </h3>
      <div className="table-scroll">
        <table className="admin-table">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" className="num">
                Qty
              </th>
              <th scope="col" className="num">
                Line total
              </th>
            </tr>
          </thead>
          <tbody>
            {sub.items.map((i) => (
              <tr key={`${i.productId}-${i.sku}`}>
                <th scope="row">{i.title}</th>
                <td className="num">{i.quantity}</td>
                <td className="num">{formatINR(i.lineNetPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Customer paid <strong>{formatINR(sub.customerTotalPaise)}</strong> · commission{' '}
        {formatINR(sub.commission.amountPaise)} ({sub.commission.rateBps / 100}%) · vendor payout{' '}
        {formatINR(sub.vendorPayoutPaise)} · refunded {formatINR(sub.refundedPaise)}
      </p>
      {sub.settlement && (
        <p>
          Settlement: <span className="badge">{settlementStatusText(sub.settlement.status)}</span> ·
          net payout {formatINR(sub.settlement.netPayoutPaise)}{' '}
          {sub.settlement.status === 'pending_release' && (
            <ReleaseButton settlement={sub.settlement} />
          )}
        </p>
      )}
      {sub.refunds.length > 0 && (
        <ul>
          {sub.refunds.map((r) => (
            <li key={r.id}>
              {formatINR(r.amountPaise)} refunded ({r.status}) – commission back{' '}
              {formatINR(r.commissionReversedPaise)}, vendor debited {formatINR(r.vendorDebitPaise)}
              {r.note ? ` – “${r.note}”` : ''}
            </li>
          ))}
        </ul>
      )}
      {sub.refundablePaise > 0 ? (
        <RefundForm sub={sub} />
      ) : (
        <p className="muted">Nothing can be refunded on this sub-order now.</p>
      )}
    </article>
  );
}

/** One order as the admin sees it: money split, refunds, settlements, and the refund and release actions. */
export default function AdminOrderPage() {
  const { orderId } = useParams();
  const {
    data: order,
    error,
    isPending,
  } = useQuery({
    queryKey: adminKey('order', { orderId }),
    queryFn: () => adminGet(`orders/${orderId}`),
  });

  if (isPending) return <p>Loading…</p>;
  if (error) {
    return (
      <p role="alert" className="error">
        {error.status === 404 ? 'Order not found.' : adminErrorMessage(error)}
      </p>
    );
  }
  return (
    <section>
      <p>
        <Link to="/admin/orders">← All orders</Link>
      </p>
      <h1>{order.orderNumber}</h1>
      <p>
        {order.customer?.name} ({order.customer?.email}) · {order.status.replaceAll('_', ' ')} ·
        payment {order.paymentStatus} · refunds {order.refundStatus}
      </p>
      <p>
        Total <strong>{formatINR(order.totalPaise)}</strong>
        {order.coupon &&
          ` · coupon ${order.coupon.code} (${order.coupon.fundedBy}-funded, −${formatINR(order.coupon.discountPaise)})`}
        {order.payment && ` · paid via ${order.payment.provider} (${order.payment.status})`}
      </p>
      <address>
        {order.shippingAddress.name}, {order.shippingAddress.line1}, {order.shippingAddress.city},{' '}
        {order.shippingAddress.state} {order.shippingAddress.postalCode}
      </address>
      <h2>Sub-orders</h2>
      {order.subOrders.map((sub) => (
        <SubOrder key={sub.id} sub={sub} />
      ))}
      {order.orderRefunds.length > 0 && (
        <p>
          Whole-order refunds:{' '}
          {order.orderRefunds
            .map(
              (r) => `${formatINR(r.amountPaise)} (${r.reason.replaceAll('_', ' ')}, ${r.status})`,
            )
            .join(', ')}
        </p>
      )}
    </section>
  );
}
