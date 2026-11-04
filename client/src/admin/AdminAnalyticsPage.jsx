import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Alert,
  Card,
  CardHeader,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
  StatCard,
} from '../components/ui';
import { adminErrorMessage, adminGet, adminKey, defaultRange, rangeIsValid } from '../lib/admin.js';
import { formatINR } from '../lib/money.js';
import { RankedTable, SalesChart } from './charts.jsx';

/** Headline figures, sales over time and the best vendors and products for a date range (UTC). */
export default function AdminAnalyticsPage() {
  const [range, setRange] = useState(() => defaultRange());
  const [interval, setInterval] = useState('day');
  const valid = rangeIsValid(range);
  const params = { from: range.from, to: range.to };

  const overview = useQuery({
    queryKey: adminKey('analytics-overview', params),
    queryFn: () => adminGet('analytics/overview', params),
    enabled: valid,
  });
  const series = useQuery({
    queryKey: adminKey('analytics-series', { ...params, interval }),
    queryFn: () => adminGet('analytics/sales-timeseries', { ...params, interval }),
    enabled: valid,
  });
  const vendors = useQuery({
    queryKey: adminKey('analytics-vendors', params),
    queryFn: () => adminGet('analytics/top-vendors', params),
    enabled: valid,
  });
  const products = useQuery({
    queryKey: adminKey('analytics-products', params),
    queryFn: () => adminGet('analytics/top-products', params),
    enabled: valid,
  });
  const failed = [overview, series, vendors, products].find((q) => q.error)?.error;
  const o = overview.data;

  return (
    <>
      <PageHeader
        title="Analytics"
        description={`Paid orders only, by the day they were paid (UTC). Figures are refreshed every 5 minutes.${
          o ? ` Computed ${new Date(o.generatedAt).toLocaleTimeString()}.` : ''
        }`}
      />

      <Card className="mb-6">
        <form className="grid gap-4 sm:grid-cols-3" onSubmit={(e) => e.preventDefault()}>
          <Field label="From">
            <Input
              type="date"
              value={range.from}
              onChange={(e) => setRange({ ...range, from: e.target.value })}
            />
          </Field>
          <Field label="To">
            <Input
              type="date"
              value={range.to}
              onChange={(e) => setRange({ ...range, to: e.target.value })}
            />
          </Field>
          <Field label="Group by">
            <Select value={interval} onChange={(e) => setInterval(e.target.value)}>
              <option value="day">Day</option>
              <option value="month">Month</option>
            </Select>
          </Field>
        </form>
      </Card>

      <div className="space-y-3 empty:hidden">
        {!valid && <Alert tone="danger">Pick a start date that is not after the end date.</Alert>}
        {failed && <Alert tone="danger">{adminErrorMessage(failed)}</Alert>}
      </div>

      {valid && overview.isPending && (
        <div
          role="status"
          aria-label="Loading figures"
          className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5"
        >
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      )}

      {o && (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard
            icon="wallet"
            label="GMV (paid orders)"
            value={formatINR(o.gmvPaise)}
            hint={`Net of refunds ${formatINR(o.netGmvPaise)}`}
          />
          <StatCard
            icon="receipt"
            label="Orders"
            value={o.orderCount}
            hint={`${o.subOrderCount} sub-orders`}
          />
          <StatCard
            icon="chart"
            label="Average order"
            value={formatINR(o.averageOrderValuePaise)}
          />
          <StatCard icon="refresh" label="Refunded" value={formatINR(o.refundedPaise)} />
          <StatCard
            icon="tag"
            label="Commission"
            value={formatINR(o.commissionPaise)}
            hint={`After refunds ${formatINR(o.netCommissionPaise)}`}
          />
        </div>
      )}

      {series.data && (
        <Card className="mt-6">
          <CardHeader title="Sales over time" />
          <SalesChart points={series.data.points} />
        </Card>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 2xl:grid-cols-2">
        {vendors.data && (
          <RankedTable
            title="Top vendors"
            rows={vendors.data.items.map((v) => ({
              id: v.vendorId,
              name: v.shopName ?? v.vendorId,
              value: v.gmvPaise,
              raw: v,
            }))}
            columns={[
              { label: 'Sub-orders', render: (v) => v.subOrderCount },
              { label: 'GMV', render: (v) => formatINR(v.gmvPaise) },
              { label: 'Commission', render: (v) => formatINR(v.commissionPaise) },
              { label: 'Refunded', render: (v) => formatINR(v.refundedPaise) },
            ]}
          />
        )}
        {products.data && (
          <RankedTable
            title="Top products"
            rows={products.data.items.map((p) => ({
              id: p.productId,
              name: p.title,
              value: p.revenuePaise,
              raw: p,
            }))}
            columns={[
              { label: 'Shop', render: (p) => p.shopName ?? '' },
              { label: 'Units', render: (p) => p.unitsSold },
              { label: 'Revenue', render: (p) => formatINR(p.revenuePaise) },
            ]}
          />
        )}
      </div>
    </>
  );
}
