import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  fetchVendorSubOrders,
  fulfillmentErrorMessage,
  refundLine,
  updateSubOrderStatus,
  vendorActions,
  VENDOR_SUB_ORDERS_KEY,
  VENDOR_SETTLEMENTS_KEY,
} from '../lib/fulfillment.js';
import { formatINR } from '../lib/money.js';
import './orders.css';

const FILTERS = [
  ['', 'All'],
  ['processing', 'To ship'],
  ['shipped', 'Shipped'],
  ['delivered', 'Delivered'],
  ['cancelled', 'Cancelled'],
];

function ShipForm({ onSubmit, disabled }) {
  const [carrier, setCarrier] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  return (
    <form
      className="ship-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ carrier: carrier.trim(), trackingNumber: trackingNumber.trim() });
      }}
    >
      <label>
        Carrier
        <input
          value={carrier}
          onChange={(e) => setCarrier(e.target.value)}
          required
          minLength={2}
          maxLength={60}
        />
      </label>
      <label>
        Tracking number
        <input
          value={trackingNumber}
          onChange={(e) => setTrackingNumber(e.target.value)}
          required
          minLength={3}
          maxLength={60}
        />
      </label>
      <button type="submit" disabled={disabled}>
        Mark as shipped
      </button>
    </form>
  );
}

function SubOrderCard({ sub }) {
  const queryClient = useQueryClient();
  const [shipping, setShipping] = useState(false);
  const change = useMutation({
    mutationFn: (body) => updateSubOrderStatus(sub.id, body),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: VENDOR_SUB_ORDERS_KEY });
      queryClient.invalidateQueries({ queryKey: VENDOR_SETTLEMENTS_KEY });
    },
    onSuccess: () => setShipping(false),
  });
  const actions = vendorActions(sub.fulfillmentStatus);
  const refund = refundLine({ ...sub });
  const a = sub.shippingAddress;

  return (
    <article className="sub-order">
      <h2>
        {sub.subOrderNumber} <small>order {sub.orderNumber}</small>
      </h2>
      <p>
        Status: <strong>{sub.fulfillmentStatus.replaceAll('_', ' ')}</strong>
        {sub.tracking && (
          <>
            {' '}
            · {sub.tracking.carrier} {sub.tracking.trackingNumber}
          </>
        )}
      </p>
      <ul className="cart-lines">
        {sub.items.map((item) => (
          <li key={item.productId} className="cart-line">
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
      <p>
        Customer paid {formatINR(sub.customerTotalPaise)} · commission{' '}
        {formatINR(sub.commission.amountPaise)} · your payout {formatINR(sub.vendorPayoutPaise)}
      </p>
      {refund && <p role="status">{refund}</p>}
      {a && (
        <address>
          Ship to: {a.name}, {a.line1}, {a.city}, {a.state} {a.postalCode}
          {a.phone && <> · {a.phone}</>}
        </address>
      )}
      {change.error && <p role="alert">{fulfillmentErrorMessage(change.error)}</p>}
      {actions.length > 0 && (
        <div className="sub-order-actions">
          {actions.includes('ship') && !shipping && (
            <button type="button" onClick={() => setShipping(true)}>
              Ship
            </button>
          )}
          {actions.includes('deliver') && (
            <button
              type="button"
              disabled={change.isPending}
              onClick={() => change.mutate({ status: 'delivered' })}
            >
              Mark as delivered
            </button>
          )}
          {actions.includes('cancel') && (
            <button
              type="button"
              className="danger"
              disabled={change.isPending}
              onClick={() => {
                if (window.confirm('Cancel this order? The customer will be refunded in full.')) {
                  change.mutate({ status: 'cancelled' });
                }
              }}
            >
              Cancel order
            </button>
          )}
        </div>
      )}
      {shipping && (
        <ShipForm
          disabled={change.isPending}
          onSubmit={(tracking) => change.mutate({ status: 'shipped', tracking })}
        />
      )}
    </article>
  );
}

/** The vendor's orders: what to ship, what is on its way, what was delivered or cancelled. */
export default function VendorOrdersPage() {
  const [filter, setFilter] = useState('');
  const { data, error, isPending } = useQuery({
    queryKey: [...VENDOR_SUB_ORDERS_KEY, filter],
    queryFn: () => fetchVendorSubOrders(filter),
  });
  return (
    <section>
      <h1>Orders</h1>
      <div className="filter-row" role="group" aria-label="Filter by status">
        {FILTERS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {isPending && <p>Loading…</p>}
      {error && <p role="alert">{fulfillmentErrorMessage(error)}</p>}
      {data?.length === 0 && <p>No orders here yet.</p>}
      {data?.map((sub) => (
        <SubOrderCard key={sub.id} sub={sub} />
      ))}
    </section>
  );
}
