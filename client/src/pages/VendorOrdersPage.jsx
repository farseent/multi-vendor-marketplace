import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Icon, Input, PageHeader, PageLoading, StatusBadge } from '../components/ui';
import { cx } from '../components/ui/classes.js';
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

const FILTERS = [
  ['', 'All'],
  ['processing', 'To ship'],
  ['shipped', 'Shipped'],
  ['delivered', 'Delivered'],
  ['cancelled', 'Cancelled'],
];

function ShipForm({ onSubmit, onCancel, disabled }) {
  const [carrier, setCarrier] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  return (
    <form
      className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ carrier: carrier.trim(), trackingNumber: trackingNumber.trim() });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Carrier">
          <Input value={carrier} onChange={(e) => setCarrier(e.target.value)} required minLength={2} maxLength={60} />
        </Field>
        <Field label="Tracking number">
          <Input
            value={trackingNumber}
            onChange={(e) => setTrackingNumber(e.target.value)}
            required
            minLength={3}
            maxLength={60}
          />
        </Field>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="submit" loading={disabled}>
          Mark as shipped
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={disabled}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Money({ label, value, strong }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={cx('tabular text-sm', strong ? 'font-semibold text-slate-900' : 'font-medium text-slate-700')}>{value}</dd>
    </div>
  );
}

function SubOrderCard({ sub }) {
  const queryClient = useQueryClient();
  const [shipping, setShipping] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const change = useMutation({
    mutationFn: (body) => updateSubOrderStatus(sub.id, body),
    onSettled: () => {
      setConfirmCancel(false);
      queryClient.invalidateQueries({ queryKey: VENDOR_SUB_ORDERS_KEY });
      queryClient.invalidateQueries({ queryKey: VENDOR_SETTLEMENTS_KEY });
    },
    onSuccess: () => setShipping(false),
  });
  const actions = vendorActions(sub.fulfillmentStatus);
  const refund = refundLine({ ...sub });
  const a = sub.shippingAddress;

  return (
    <Card as="article" padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="min-w-0">
          <h2 className="font-semibold text-slate-900">{sub.subOrderNumber}</h2>
          <p className="text-xs text-slate-500">Order {sub.orderNumber}</p>
        </div>
        <StatusBadge status={sub.fulfillmentStatus} />
      </div>

      <ul className="divide-y divide-slate-100">
        {sub.items.map((item) => (
          <li key={item.productId} className="flex items-center justify-between gap-4 px-5 py-3">
            <div className="min-w-0">
              <p className="line-clamp-2 text-sm font-medium text-slate-900">{item.title}</p>
              <p className="tabular text-xs text-slate-500">
                {item.quantity} × {formatINR(item.unitPricePaise)}
              </p>
            </div>
            <p className="tabular text-sm font-semibold text-slate-900">{formatINR(item.lineNetPaise)}</p>
          </li>
        ))}
      </ul>

      <div className="space-y-4 border-t border-slate-100 bg-slate-50/60 px-5 py-4">
        <dl className="grid grid-cols-3 gap-4">
          <Money label="Customer paid" value={formatINR(sub.customerTotalPaise)} />
          <Money label="Commission" value={formatINR(sub.commission.amountPaise)} />
          <Money label="Your payout" value={formatINR(sub.vendorPayoutPaise)} strong />
        </dl>
        {sub.tracking && (
          <p className="flex items-center gap-2 text-sm text-slate-700">
            <Icon name="truck" className="size-4.5 text-slate-400" />
            {sub.tracking.carrier} {sub.tracking.trackingNumber}
          </p>
        )}
        {refund && <Alert tone="info">{refund}</Alert>}
        {a && (
          <address className="flex gap-2 text-sm not-italic text-slate-700">
            <Icon name="map-pin" className="mt-0.5 size-4.5 shrink-0 text-slate-400" />
            <span>
              Ship to: {a.name}, {a.line1}, {a.city}, {a.state} {a.postalCode}
              {a.phone && <> · {a.phone}</>}
            </span>
          </address>
        )}
        {change.error && <Alert tone="danger">{fulfillmentErrorMessage(change.error)}</Alert>}
        {actions.length > 0 && !shipping && (
          <div className="flex flex-wrap gap-2">
            {actions.includes('ship') && <Button onClick={() => setShipping(true)}>Ship</Button>}
            {actions.includes('deliver') && (
              <Button loading={change.isPending} onClick={() => change.mutate({ status: 'delivered' })}>
                Mark as delivered
              </Button>
            )}
            {actions.includes('cancel') && (
              <Button variant="danger-outline" disabled={change.isPending} onClick={() => setConfirmCancel(true)}>
                Cancel order
              </Button>
            )}
          </div>
        )}
        {shipping && (
          <ShipForm
            disabled={change.isPending}
            onCancel={() => setShipping(false)}
            onSubmit={(tracking) => change.mutate({ status: 'shipped', tracking })}
          />
        )}
      </div>

      <ConfirmDialog
        open={confirmCancel}
        title="Cancel this order?"
        message="The customer will be refunded in full."
        confirmLabel="Cancel order"
        cancelLabel="Keep order"
        pending={change.isPending}
        onConfirm={() => change.mutate({ status: 'cancelled' })}
        onCancel={() => setConfirmCancel(false)}
      />
    </Card>
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
    <>
      <PageHeader title="Orders" description="What to ship, what is on its way, and what is done." />
      <div role="group" aria-label="Filter by status" className="mb-6 flex flex-wrap gap-2">
        {FILTERS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
            className={cx(
              'min-h-10 rounded-full border px-4 text-sm font-medium transition-colors',
              filter === value
                ? 'border-brand-600 bg-brand-600 text-white'
                : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {isPending && <PageLoading />}
      {error && <ErrorState message={fulfillmentErrorMessage(error)} />}
      {data?.length === 0 && (
        <EmptyState icon="receipt" title="No orders here yet" description="Orders for your products will appear here." />
      )}
      <div className="space-y-5">
        {data?.map((sub) => (
          <SubOrderCard key={sub.id} sub={sub} />
        ))}
      </div>
    </>
  );
}