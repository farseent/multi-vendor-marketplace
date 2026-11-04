import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Card, CardHeader, ConfirmDialog, ErrorState, Field, Icon, Input, LinkButton, PageHeader, PageLoading, StatusBadge, Table, TBody, Td, Th, THead } from '../components/ui';
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
  const [request, setRequest] = useState(null); // validated body waiting for confirmation
  // One key per intended refund: a double click or a retry after a timeout is the SAME request.
  const key = useRef(crypto.randomUUID());
  const refund = useAdminAction((body) =>
    adminSend(`sub-orders/${sub.id}/refund`, 'POST', body, { 'Idempotency-Key': key.current }),
  );

  const amountText = request?.amountPaise ? formatINR(request.amountPaise) : `all ${formatINR(sub.refundablePaise)}`;

  return (
    <form
      className="grid gap-4 sm:grid-cols-[14rem_1fr_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        const result = refundRequest({ amount, note, refundablePaise: sub.refundablePaise });
        setMessage(result.ok ? null : result.message);
        if (result.ok) setRequest(result.body);
      }}
    >
      <Field label={`Amount (₹, empty = all ${formatINR(sub.refundablePaise)})`}>
        <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
      </Field>
      <Field label="Note">
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} required minLength={3} />
      </Field>
      <Button type="submit" variant="danger-outline" loading={refund.isPending}>
        Refund customer
      </Button>
      {(message || refund.error) && (
        <div className="sm:col-span-3">
          <Alert tone="danger">{message ?? adminErrorMessage(refund.error)}</Alert>
        </div>
      )}
      <ConfirmDialog
        open={Boolean(request)}
        title="Refund this customer?"
        message={`${amountText} will be refunded for ${sub.subOrderNumber}. This cannot be undone.`}
        confirmLabel="Refund customer"
        pending={refund.isPending}
        onConfirm={() =>
          refund.mutate(request, {
            onSuccess: () => {
              key.current = crypto.randomUUID();
              setAmount('');
              setNote('');
            },
            onSettled: () => setRequest(null),
          })
        }
        onCancel={() => setRequest(null)}
      />
    </form>
  );
}

function ReleaseButton({ settlement }) {
  const [confirming, setConfirming] = useState(false);
  const release = useAdminAction(() => adminSend(`settlements/${settlement.id}/release`, 'POST'));
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setConfirming(true)} disabled={release.isPending}>
        Release payout early
      </Button>
      {release.error && <Alert tone="danger" className="mt-2">{adminErrorMessage(release.error)}</Alert>}
      <ConfirmDialog
        open={confirming}
        title="Release this payout now?"
        message="This pays the vendor before the 7-day return window ends."
        confirmLabel="Release payout"
        tone="primary"
        pending={release.isPending}
        onConfirm={() => release.mutate(undefined, { onSettled: () => setConfirming(false) })}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

function Money({ label, value, strong }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={`tabular text-sm ${strong ? 'font-semibold text-slate-900' : 'font-medium text-slate-700'}`}>{value}</dd>
    </div>
  );
}

function SubOrder({ sub }) {
  return (
    <Card as="article" padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="min-w-0">
          <h3 className="font-semibold text-slate-900">{sub.shop.name}</h3>
          <p className="text-xs text-slate-500">{sub.subOrderNumber}</p>
        </div>
        <StatusBadge status={sub.fulfillmentStatus} />
      </div>
      <Table label={`Items in ${sub.subOrderNumber}`} flush>
        <THead>
          <Th>Item</Th>
          <Th num>Qty</Th>
          <Th num>Line total</Th>
        </THead>
        <TBody>
          {sub.items.map((i) => (
            <tr key={`${i.productId}-${i.sku}`}>
              <Td header>{i.title}</Td>
              <Td num>{i.quantity}</Td>
              <Td num>{formatINR(i.lineNetPaise)}</Td>
            </tr>
          ))}
        </TBody>
      </Table>
      <div className="space-y-4 border-t border-slate-100 bg-slate-50/60 px-5 py-4">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Money label="Customer paid" value={formatINR(sub.customerTotalPaise)} strong />
          <Money
            label={`Commission (${sub.commission.rateBps / 100}%)`}
            value={formatINR(sub.commission.amountPaise)}
          />
          <Money label="Vendor payout" value={formatINR(sub.vendorPayoutPaise)} />
          <Money label="Refunded" value={formatINR(sub.refundedPaise)} />
        </dl>
        {sub.settlement && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-slate-700">
            <span>Settlement:</span>
            <StatusBadge status={sub.settlement.status} label={settlementStatusText(sub.settlement.status)} className="capitalize" />
            <span>
              net payout <strong className="tabular">{formatINR(sub.settlement.netPayoutPaise)}</strong>
            </span>
            {sub.settlement.status === 'pending_release' && <ReleaseButton settlement={sub.settlement} />}
          </div>
        )}
        {sub.refunds.length > 0 && (
          <ul className="space-y-2 text-sm text-slate-700">
            {sub.refunds.map((r) => (
              <li key={r.id} className="rounded-lg border border-slate-200 bg-white p-3">
                <strong className="tabular">{formatINR(r.amountPaise)}</strong> refunded ({r.status}) – commission
                back {formatINR(r.commissionReversedPaise)}, vendor debited {formatINR(r.vendorDebitPaise)}
                {r.note ? ` – \u201c${r.note}\u201d` : ''}
              </li>
            ))}
          </ul>
        )}
        {sub.refundablePaise > 0 ? (
          <RefundForm sub={sub} />
        ) : (
          <p className="text-sm text-slate-500">Nothing can be refunded on this sub-order now.</p>
        )}
      </div>
    </Card>
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

  if (isPending) return <PageLoading />;
  if (error) {
    return (
      <ErrorState
        title={error.status === 404 ? 'Order not found' : 'We could not load this order'}
        message={error.status === 404 ? undefined : adminErrorMessage(error)}
        action={<LinkButton to="/admin/orders">All orders</LinkButton>}
      />
    );
  }
  return (
    <>
      <PageHeader
        back={{ to: '/admin/orders', label: 'All orders' }}
        title={order.orderNumber}
        description={`${order.customer?.name ?? ''} (${order.customer?.email ?? ''})`}
        actions={<StatusBadge status={order.status} />}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader title="Payment" />
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Total</dt>
              <dd className="tabular font-semibold text-slate-900">{formatINR(order.totalPaise)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-500">Payment</dt>
              <dd>
                <StatusBadge status={order.paymentStatus} />
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-500">Refunds</dt>
              <dd>
                <StatusBadge status={order.refundStatus} />
              </dd>
            </div>
            {order.payment && (
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Paid via</dt>
                <dd className="text-slate-900">
                  {order.payment.provider} ({order.payment.status})
                </dd>
              </div>
            )}
            {order.coupon && (
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Coupon</dt>
                <dd className="text-right text-slate-900">
                  {order.coupon.code} ({order.coupon.fundedBy}-funded, −{formatINR(order.coupon.discountPaise)})
                </dd>
              </div>
            )}
          </dl>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Shipping address" />
          <address className="flex gap-3 text-sm not-italic text-slate-700">
            <Icon name="map-pin" className="mt-0.5 size-4.5 text-slate-400" />
            <span>
              {order.shippingAddress.name}, {order.shippingAddress.line1}, {order.shippingAddress.city},{' '}
              {order.shippingAddress.state} {order.shippingAddress.postalCode}
            </span>
          </address>
        </Card>
      </div>

      <h2 className="mb-4 mt-8 text-lg font-semibold text-slate-900">Sub-orders</h2>
      <div className="space-y-5">
        {order.subOrders.map((sub) => (
          <SubOrder key={sub.id} sub={sub} />
        ))}
      </div>
      {order.orderRefunds.length > 0 && (
        <Alert tone="info" className="mt-6">
          Whole-order refunds:{' '}
          {order.orderRefunds
            .map((r) => `${formatINR(r.amountPaise)} (${r.reason.replaceAll('_', ' ')}, ${r.status})`)
            .join(', ')}
        </Alert>
      )}
    </>
  );
}