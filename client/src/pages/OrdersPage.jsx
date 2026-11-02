import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { fetchOrders, ORDERS_KEY, orderStatusLabel } from '../lib/checkout.js';
import { formatINR } from '../lib/money.js';
import './orders.css';

/** The customer's orders, newest first. */
export default function OrdersPage() {
  const {
    data: orders,
    error,
    isPending,
  } = useQuery({ queryKey: ORDERS_KEY, queryFn: fetchOrders });
  if (isPending) return <p>Loading…</p>;
  if (error) return <p role="alert">{error.message}</p>;
  return (
    <section>
      <h1>Your orders</h1>
      {orders.length === 0 ? (
        <p>
          You have no orders yet. <Link to="/search">Browse products</Link>
        </p>
      ) : (
        <ul className="order-list">
          {orders.map((order) => (
            <li key={order.id}>
              <Link to={`/orders/${order.id}`}>{order.orderNumber}</Link>
              <span>{new Date(order.createdAt).toLocaleDateString('en-IN')}</span>
              <span>{orderStatusLabel(order)}</span>
              <strong>{formatINR(order.totalPaise)}</strong>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
