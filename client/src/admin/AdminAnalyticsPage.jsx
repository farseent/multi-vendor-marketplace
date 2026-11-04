import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { adminErrorMessage, adminGet, adminKey, defaultRange, rangeIsValid } from '../lib/admin.js';
import { formatINR } from '../lib/money.js';
import { RankedTable, SalesChart } from './charts.jsx';

function Stat({ label, value, hint }) {
  return (
    <div className="stat">
      <strong>{value}</strong>
      <span>{label}</span>
      {hint && <div className="muted">{hint}</div>}
    </div>
  );
}

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
    <section>
      <h1>Analytics</h1>
      <form className="admin-filters" onSubmit={(e) => e.preventDefault()}>
        <label>
          From
          <input
            type="date"
            value={range.from}
            onChange={(e) => setRange({ ...range, from: e.target.value })}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={range.to}
            onChange={(e) => setRange({ ...range, to: e.target.value })}
          />
        </label>
        <label>
          Group by
          <select value={interval} onChange={(e) => setInterval(e.target.value)}>
            <option value="day">Day</option>
            <option value="month">Month</option>
          </select>
        </label>
      </form>
      <p className="muted">
        Paid orders only, by the day they were paid (UTC). Figures are refreshed every 5 minutes.
        {o && ` Computed ${new Date(o.generatedAt).toLocaleTimeString()}.`}
      </p>
      {!valid && (
        <p role="alert" className="error">
          Pick a start date that is not after the end date.
        </p>
      )}
      {failed && (
        <p role="alert" className="error">
          {adminErrorMessage(failed)}
        </p>
      )}
      {valid && overview.isPending && <p>Loading…</p>}

      {o && (
        <div className="stat-grid">
          <Stat
            label="GMV (paid orders)"
            value={formatINR(o.gmvPaise)}
            hint={`Net of refunds ${formatINR(o.netGmvPaise)}`}
          />
          <Stat label="Orders" value={o.orderCount} hint={`${o.subOrderCount} sub-orders`} />
          <Stat label="Average order" value={formatINR(o.averageOrderValuePaise)} />
          <Stat label="Refunded" value={formatINR(o.refundedPaise)} />
          <Stat
            label="Commission"
            value={formatINR(o.commissionPaise)}
            hint={`After refunds ${formatINR(o.netCommissionPaise)}`}
          />
        </div>
      )}

      {series.data && (
        <>
          <h2>Sales over time</h2>
          <SalesChart points={series.data.points} />
        </>
      )}
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
    </section>
  );
}
