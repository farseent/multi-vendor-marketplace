import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, EmptyState, Field, Icon, Input, PageHeader, PageLoading, Pagination, Select, StatusBadge, Table, TBody, Td, Th, THead } from '../components/ui';
import { adminErrorMessage, adminKey, adminList } from '../lib/admin.js';
import { formatINR } from '../lib/money.js';

const select = (label, name, values, filters, setFilters) => (
  <Field label={label}>
    <Select
      value={filters[name]}
      onChange={(e) => setFilters({ ...filters, [name]: e.target.value, page: 1 })}
    >
      <option value="">All</option>
      {values.map((v) => (
        <option key={v} value={v}>
          {v.replaceAll('_', ' ')}
        </option>
      ))}
    </Select>
  </Field>
);

/** All orders, newest first; find one by (the start of) its number. */
export default function AdminOrdersPage() {
  const [filters, setFilters] = useState({
    status: '',
    paymentStatus: '',
    refundStatus: '',
    q: '',
    page: 1,
  });
  const [text, setText] = useState('');
  const { data, error, isPending } = useQuery({
    queryKey: adminKey('orders', filters),
    queryFn: () => adminList('orders', filters),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader title="Orders" description="Every order on the marketplace, newest first." />
      <Card className="mb-6">
        <form
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr_auto] lg:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters({ ...filters, q: text.trim(), page: 1 });
          }}
        >
          <Field label="Order number">
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="MP-2026…" maxLength={100} />
          </Field>
          {select(
            'Order status',
            'status',
            ['pending_payment', 'placed', 'completed', 'cancelled', 'expired'],
            filters,
            setFilters,
          )}
          {select('Payment', 'paymentStatus', ['unpaid', 'paid', 'failed'], filters, setFilters)}
          {select('Refunds', 'refundStatus', ['none', 'partial', 'full'], filters, setFilters)}
          <Button type="submit">
            <Icon name="search" className="size-4" />
            Search
          </Button>
        </form>
      </Card>
      {error && <Alert tone="danger" className="mb-4">{adminErrorMessage(error)}</Alert>}
      {isPending && <PageLoading />}
      {data?.items.length === 0 && <EmptyState icon="receipt" title="No orders match" description="Try different filters." />}
      {data?.items.length > 0 && (
        <Table label="Orders">
          <THead>
            <Th>Order</Th>
            <Th>Customer</Th>
            <Th>Placed</Th>
            <Th>Status</Th>
            <Th>Payment</Th>
            <Th>Refunds</Th>
            <Th num>Total</Th>
          </THead>
          <TBody>
            {data.items.map((o) => (
              <tr key={o.id}>
                <Td header>
                  <Link to={`/admin/orders/${o.id}`} className="text-brand-600 hover:underline">
                    {o.orderNumber}
                  </Link>
                </Td>
                <Td>{o.customer?.email}</Td>
                <Td className="whitespace-nowrap">{new Date(o.placedAt ?? o.createdAt).toLocaleString()}</Td>
                <Td>
                  <StatusBadge status={o.status} />
                </Td>
                <Td>
                  <StatusBadge status={o.paymentStatus} />
                </Td>
                <Td>
                  <StatusBadge status={o.refundStatus} />
                </Td>
                <Td num>{formatINR(o.totalPaise)}</Td>
              </tr>
            ))}
          </TBody>
        </Table>
      )}
      <Pagination meta={data?.meta} onPage={(page) => setFilters({ ...filters, page })} showTotal />
    </>
  );
}