import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { adminErrorMessage, adminKey, adminList } from '../lib/admin.js';
import { formatINR } from '../lib/money.js';
import Pager from './Pager.jsx';

const select = (label, name, values, filters, setFilters) => (
  <label>
    {label}
    <select
      value={filters[name]}
      onChange={(e) => setFilters({ ...filters, [name]: e.target.value, page: 1 })}
    >
      <option value="">All</option>
      {values.map((v) => (
        <option key={v} value={v}>
          {v.replaceAll('_', ' ')}
        </option>
      ))}
    </select>
  </label>
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
    <section>
      <h1>Orders</h1>
      <form
        className="admin-filters"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters({ ...filters, q: text.trim(), page: 1 });
        }}
      >
        <label>
          Order number
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="MP-2026…"
            maxLength={100}
          />
        </label>
        {select(
          'Order status',
          'status',
          ['pending_payment', 'placed', 'completed', 'cancelled', 'expired'],
          filters,
          setFilters,
        )}
        {select('Payment', 'paymentStatus', ['unpaid', 'paid', 'failed'], filters, setFilters)}
        {select('Refunds', 'refundStatus', ['none', 'partial', 'full'], filters, setFilters)}
        <button type="submit">Search</button>
      </form>
      {error && (
        <p role="alert" className="error">
          {adminErrorMessage(error)}
        </p>
      )}
      {isPending && <p>Loading…</p>}
      {data?.items.length === 0 && <p>No orders match.</p>}
      {data?.items.length > 0 && (
        <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Customer</th>
                <th scope="col">Placed</th>
                <th scope="col">Status</th>
                <th scope="col">Payment</th>
                <th scope="col">Refunds</th>
                <th scope="col" className="num">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((o) => (
                <tr key={o.id}>
                  <th scope="row">
                    <Link to={`/admin/orders/${o.id}`}>{o.orderNumber}</Link>
                  </th>
                  <td>{o.customer?.email}</td>
                  <td>{new Date(o.placedAt ?? o.createdAt).toLocaleString()}</td>
                  <td>{o.status.replaceAll('_', ' ')}</td>
                  <td>{o.paymentStatus}</td>
                  <td>{o.refundStatus}</td>
                  <td className="num">{formatINR(o.totalPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager meta={data?.meta} onPage={(page) => setFilters({ ...filters, page })} />
    </section>
  );
}
