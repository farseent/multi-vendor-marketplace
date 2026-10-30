import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../lib/api.js';
import { formatINR } from '../lib/money.js';
import './catalog.css';

const LIMIT = 20;
const STATUSES = ['', 'draft', 'active', 'archived', 'suspended'];

export default function VendorProductsPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');

  const { data, error, isPending } = useQuery({
    queryKey: ['vendor', 'products', { page, status }],
    queryFn: async () => {
      const query = new URLSearchParams({ page, limit: LIMIT, ...(status && { status }) });
      return apiFetch(`/vendor/products?${query}`);
    },
    retry: false,
  });

  const archive = useMutation({
    mutationFn: (id) => apiFetch(`/vendor/products/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['vendor', 'products'] }),
  });

  if (error?.code === 'FORBIDDEN') {
    return (
      <p role="alert">
        Create your <Link to="/vendor/shop">shop profile</Link> first.
      </p>
    );
  }

  const products = data?.data ?? [];
  const meta = data?.meta;

  return (
    <>
      <div className="toolbar">
        <h1>Your products</h1>
        <Link to="/vendor/products/new">Add product</Link>
      </div>
      <label>
        Status{' '}
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s || 'all'}
            </option>
          ))}
        </select>
      </label>

      {isPending && <p>Loading…</p>}
      {error && <p role="alert">{error.message}</p>}
      {archive.error && <p role="alert">{archive.error.message}</p>}
      {data && products.length === 0 && <p>No products yet.</p>}
      {products.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Price</th>
              <th>Stock</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link to={`/vendor/products/${p.id}`}>{p.title}</Link>
                </td>
                <td>{formatINR(p.pricePaise)}</td>
                <td>{p.stockQty}</td>
                <td>
                  <span className={`badge ${p.status}`}>{p.status}</span>
                </td>
                <td>
                  {p.status === 'active' && <Link to={`/products/${p.slug}`}>View</Link>}{' '}
                  {p.status !== 'archived' && p.status !== 'suspended' && (
                    <button
                      type="button"
                      disabled={archive.isPending}
                      onClick={() =>
                        window.confirm('Archive this product?') && archive.mutate(p.id)
                      }
                    >
                      Archive
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {meta && meta.totalPages > 1 && (
        <div className="pager">
          <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span>
            Page {meta.page} of {meta.totalPages}
          </span>
          <button
            type="button"
            disabled={page >= meta.totalPages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </div>
      )}
    </>
  );
}
