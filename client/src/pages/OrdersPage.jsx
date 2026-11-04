import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Container,
  EmptyState,
  ErrorState,
  Icon,
  LinkButton,
  PageHeader,
  PageLoading,
  StatusBadge,
} from '../components/ui';
import { fetchOrders, ORDERS_KEY, orderStatusLabel } from '../lib/checkout.js';
import { formatINR } from '../lib/money.js';

/** The customer's orders, newest first. */
export default function OrdersPage() {
  const {
    data: orders,
    error,
    isPending,
  } = useQuery({ queryKey: ORDERS_KEY, queryFn: fetchOrders });

  return (
    <Container narrow className="py-8 sm:py-10">
      <PageHeader
        title="Your orders"
        description="Open an order to pay, track shipments or download an invoice."
      />
      {isPending && <PageLoading />}
      {error && <ErrorState message={error.message} />}
      {orders?.length === 0 && (
        <EmptyState
          icon="receipt"
          title="You have no orders yet"
          description="When you place an order it will show up here."
          action={<LinkButton to="/search">Browse products</LinkButton>}
        />
      )}
      {orders?.length > 0 && (
        <ul className="space-y-3">
          {orders.map((order) => (
            <li key={order.id}>
              <Link
                to={`/orders/${order.id}`}
                className="group flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-slate-200 bg-white p-4 shadow-card transition hover:border-slate-300 hover:shadow-md sm:p-5"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-slate-900 group-hover:text-brand-700">
                    {order.orderNumber}
                  </p>
                  <p className="text-sm text-slate-500">
                    Placed{' '}
                    {new Date(order.createdAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })}
                  </p>
                </div>
                <StatusBadge status={order.status} label={orderStatusLabel(order)} />
                <p className="tabular ml-auto text-base font-semibold text-slate-900">
                  {formatINR(order.totalPaise)}
                </p>
                <Icon name="chevron-right" className="hidden size-5 text-slate-400 sm:block" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Container>
  );
}
