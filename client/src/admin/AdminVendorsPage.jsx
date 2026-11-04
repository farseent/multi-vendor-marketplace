import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  adminErrorMessage,
  adminKey,
  adminList,
  adminSend,
  bpsToPercent,
  percentToBps,
  vendorNextStatuses,
} from '../lib/admin.js';
import { useAdminAction } from './hooks.js';
import Pager from './Pager.jsx';

const STATUSES = ['', 'pending', 'approved', 'rejected', 'suspended'];
const VERBS = { approved: 'Approve', rejected: 'Reject', suspended: 'Suspend' };

function CommissionForm({ vendor, onSave, disabled }) {
  const [text, setText] = useState(bpsToPercent(vendor.commissionRateBps));
  const bps = percentToBps(text);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (bps !== undefined) onSave(bps);
      }}
    >
      <label>
        <span className="muted">Commission %</span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="default"
          size={6}
          inputMode="decimal"
          aria-label={`Commission percent for ${vendor.shopName}`}
          aria-invalid={bps === undefined}
        />
      </label>
      <button type="submit" disabled={disabled || bps === undefined}>
        Save
      </button>
    </form>
  );
}

/** Approve, reject or suspend shops and set a shop's own commission rate. */
export default function AdminVendorsPage() {
  const [filters, setFilters] = useState({ status: '', page: 1 });
  const { data, error, isPending } = useQuery({
    queryKey: adminKey('vendors', filters),
    queryFn: () => adminList('vendors', filters),
    placeholderData: keepPreviousData,
  });
  const setStatus = useAdminAction(({ id, status }) =>
    adminSend(`vendors/${id}/status`, 'PATCH', { status }),
  );
  const setCommission = useAdminAction(({ id, bps }) =>
    adminSend(`vendors/${id}/commission`, 'PATCH', { commissionRateBps: bps }),
  );
  const problem = error ?? setStatus.error ?? setCommission.error;

  return (
    <section>
      <h1>Vendors</h1>
      <div className="admin-filters">
        <label>
          Status
          <select
            value={filters.status}
            onChange={(e) => setFilters({ status: e.target.value, page: 1 })}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s || 'All'}
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
      {data?.items.length === 0 && <p>No shops match.</p>}
      {data?.items.length > 0 && (
        <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Shop</th>
                <th scope="col">Owner</th>
                <th scope="col">Status</th>
                <th scope="col">Commission</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((v) => (
                <tr key={v.id}>
                  <th scope="row">{v.shopName}</th>
                  <td>{v.owner ? `${v.owner.name} (${v.owner.email})` : ''}</td>
                  <td>
                    <span className="badge">{v.status}</span>
                  </td>
                  <td>
                    <CommissionForm
                      key={`${v.id}-${v.commissionRateBps}`}
                      vendor={v}
                      disabled={setCommission.isPending}
                      onSave={(bps) => setCommission.mutate({ id: v.id, bps })}
                    />
                  </td>
                  <td>
                    <div className="admin-actions">
                      {vendorNextStatuses(v.status).map((status) => (
                        <button
                          key={status}
                          type="button"
                          disabled={setStatus.isPending}
                          onClick={() => setStatus.mutate({ id: v.id, status })}
                        >
                          {VERBS[status]}
                        </button>
                      ))}
                    </div>
                  </td>
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
