import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { adminErrorMessage, adminKey, adminList, adminSend } from '../lib/admin.js';
import { useAdminAction } from './hooks.js';
import Pager from './Pager.jsx';

/** Moderation: every review, newest first. Hiding one removes it from the product page and its rating. */
export default function AdminReviewsPage() {
  const [filters, setFilters] = useState({ status: '', page: 1 });
  const { data, error, isPending } = useQuery({
    queryKey: adminKey('reviews', filters),
    queryFn: () => adminList('reviews', filters),
    placeholderData: keepPreviousData,
  });
  const setStatus = useAdminAction(({ id, status }) =>
    adminSend(`reviews/${id}/status`, 'PATCH', { status }),
  );
  const problem = error ?? setStatus.error;

  return (
    <section>
      <h1>Reviews</h1>
      <div className="admin-filters">
        <label>
          Status
          <select
            value={filters.status}
            onChange={(e) => setFilters({ status: e.target.value, page: 1 })}
          >
            <option value="">All</option>
            <option value="published">Published</option>
            <option value="hidden">Hidden</option>
          </select>
        </label>
      </div>
      {problem && (
        <p role="alert" className="error">
          {adminErrorMessage(problem)}
        </p>
      )}
      {isPending && <p>Loading…</p>}
      {data?.items.length === 0 && <p>No reviews match.</p>}
      {data?.items.length > 0 && (
        <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col" className="num">
                  Rating
                </th>
                <th scope="col">Review</th>
                <th scope="col">Customer</th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id}>
                  <th scope="row">{r.product.title ?? r.product.id}</th>
                  <td className="num">{r.rating} / 5</td>
                  <td>
                    {r.title && <strong>{r.title}. </strong>}
                    {r.body}
                  </td>
                  <td>{r.customer?.email}</td>
                  <td>
                    <span className={`badge ${r.status === 'hidden' ? 'bad' : ''}`}>
                      {r.status}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      disabled={setStatus.isPending}
                      onClick={() =>
                        setStatus.mutate({
                          id: r.id,
                          status: r.status === 'hidden' ? 'published' : 'hidden',
                        })
                      }
                    >
                      {r.status === 'hidden' ? 'Publish' : 'Hide'}
                    </button>
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
