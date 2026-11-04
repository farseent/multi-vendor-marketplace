import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  adminErrorMessage,
  adminKey,
  adminList,
  adminSend,
  settlementStatusText,
} from '../lib/admin.js';
import { formatINR } from '../lib/money.js';
import { useAdminAction } from './hooks.js';
import Pager from './Pager.jsx';

const STATUSES = ['not_eligible', 'pending_release', 'released', 'settled', 'reversed', 'failed'];

function Reconciliation() {
  const { data, error } = useQuery({
    queryKey: adminKey('reconciliation', {}),
    queryFn: () => adminList('reconciliation', { limit: 5 }),
  });
  const run = useAdminAction(() => adminSend('reconciliation/run', 'POST'));
  return (
    <section>
      <h2>Reconciliation</h2>
      <p>
        Compares our payout records with the payment provider&apos;s transfers. It only reports: it
        never changes any payment, refund or settlement.
      </p>
      <button type="button" disabled={run.isPending} onClick={() => run.mutate()}>
        Run now
      </button>
      {(error || run.error) && (
        <p role="alert" className="error">
          {adminErrorMessage(error ?? run.error)}
        </p>
      )}
      {data?.items.length === 0 && <p>No report yet.</p>}
      {data?.items.map((r) => (
        <details key={r.id}>
          <summary>
            {new Date(r.runAt).toLocaleString()} –{' '}
            <span className={`badge ${r.status === 'ok' ? 'good' : 'bad'}`}>{r.status}</span> (
            {r.totals.settlementsChecked} checked, {r.totals.mismatchCount} mismatches)
          </summary>
          {r.mismatches.length === 0 ? (
            <p>Nothing to report.</p>
          ) : (
            <ul>
              {r.mismatches.map((m, i) => (
                <li key={`${r.id}-${i}`}>
                  {m.type.replaceAll('_', ' ')}
                  {m.detail ? `: ${m.detail}` : ''}
                  {m.expected !== undefined ? ` (expected ${m.expected}, found ${m.actual})` : ''}
                </li>
              ))}
            </ul>
          )}
        </details>
      ))}
    </section>
  );
}

/** Vendor payouts across the marketplace, an early-release button, and the reconciliation report. */
export default function AdminSettlementsPage() {
  const [filters, setFilters] = useState({ status: '', page: 1 });
  const { data, error, isPending } = useQuery({
    queryKey: adminKey('settlements', filters),
    queryFn: () => adminList('settlements', filters),
    placeholderData: keepPreviousData,
  });
  const release = useAdminAction((id) => adminSend(`settlements/${id}/release`, 'POST'));
  const problem = error ?? release.error;

  return (
    <section>
      <h1>Settlements</h1>
      <div className="admin-filters">
        <label>
          Status
          <select
            value={filters.status}
            onChange={(e) => setFilters({ status: e.target.value, page: 1 })}
          >
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {settlementStatusText(s)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {problem && (
        <p role="alert" className="error">
          {adminErrorMessage(problem)}
        </p>
      )}
      {isPending && <p>Loading…</p>}
      {data?.items.length === 0 && <p>No settlements match.</p>}
      {data?.items.length > 0 && (
        <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Sub-order</th>
                <th scope="col" className="num">
                  Gross
                </th>
                <th scope="col" className="num">
                  Commission
                </th>
                <th scope="col" className="num">
                  Refunds
                </th>
                <th scope="col" className="num">
                  Net payout
                </th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((s) => (
                <tr key={s.id}>
                  <th scope="row">{s.subOrderNumber}</th>
                  <td className="num">{formatINR(s.grossPaise)}</td>
                  <td className="num">{formatINR(s.commissionPaise)}</td>
                  <td className="num">
                    {s.refundAdjustmentPaise ? formatINR(s.refundAdjustmentPaise) : '—'}
                  </td>
                  <td className="num">{formatINR(s.netPayoutPaise)}</td>
                  <td>
                    {settlementStatusText(s.status)}
                    {s.failureReason && <div className="muted">{s.failureReason}</div>}
                  </td>
                  <td>
                    {s.status === 'pending_release' && (
                      <button
                        type="button"
                        disabled={release.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              'Release this payout now, before the 7-day return window ends?',
                            )
                          ) {
                            release.mutate(s.id);
                          }
                        }}
                      >
                        Release early
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager meta={data?.meta} onPage={(page) => setFilters({ ...filters, page })} />
      <Reconciliation />
    </section>
  );
}
