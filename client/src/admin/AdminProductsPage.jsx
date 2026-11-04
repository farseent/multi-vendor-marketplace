import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { adminErrorMessage, adminKey, adminList, adminSend } from '../lib/admin.js';
import { formatINR } from '../lib/money.js';
import { useAdminAction } from './hooks.js';
import Pager from './Pager.jsx';

const STATUSES = ['', 'active', 'draft', 'archived', 'suspended'];

/** Every product of every shop. An admin can suspend one, or send a suspended one back to draft. */
export default function AdminProductsPage() {
  const [filters, setFilters] = useState({ status: '', q: '', page: 1 });
  const [text, setText] = useState('');
  const { data, error, isPending } = useQuery({
    queryKey: adminKey('products', filters),
    queryFn: () => adminList('products', filters),
    placeholderData: keepPreviousData,
  });
  const setStatus = useAdminAction(({ id, status }) =>
    adminSend(`products/${id}/status`, 'PATCH', { status }),
  );
  const problem = error ?? setStatus.error;

  return (
    <section>
      <h1>Products</h1>
      <form
        className="admin-filters"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters({ ...filters, q: text.trim(), page: 1 });
        }}
      >
        <label>
          Status
          <select
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value, page: 1 })}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s || 'All'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Title contains
          <input value={text} onChange={(e) => setText(e.target.value)} maxLength={100} />
        </label>
        <button type="submit">Filter</button>
      </form>
      {problem && (
        <p role="alert" className="error">
          {adminErrorMessage(problem)}
        </p>
      )}
      {isPending && <p>Loading…</p>}
      {data?.items.length === 0 && <p>No products match.</p>}
      {data?.items.length > 0 && (
        <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Shop</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Price
                </th>
                <th scope="col" className="num">
                  Stock
                </th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id}>
                  <th scope="row">{p.title}</th>
                  <td>{p.shop?.name}</td>
                  <td>
                    <span className={`badge ${p.status === 'suspended' ? 'bad' : ''}`}>
                      {p.status}
                    </span>
                  </td>
                  <td className="num">{formatINR(p.pricePaise)}</td>
                  <td className="num">{p.stockQty}</td>
                  <td>
                    {p.status === 'suspended' ? (
                      <button
                        type="button"
                        disabled={setStatus.isPending}
                        title="Back to draft: the vendor publishes it again"
                        onClick={() => setStatus.mutate({ id: p.id, status: 'draft' })}
                      >
                        Restore to draft
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={setStatus.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Suspend “${p.title}”? It disappears from the shop and search.`,
                            )
                          ) {
                            setStatus.mutate({ id: p.id, status: 'suspended' });
                          }
                        }}
                      >
                        Suspend
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
    </section>
  );
}
