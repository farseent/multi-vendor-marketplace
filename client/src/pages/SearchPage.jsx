import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../lib/api.js';
import { formatINR } from '../lib/money.js';
import {
  SORT_OPTIONS,
  flattenCategories,
  readFilters,
  toApiQuery,
  toUrlParams,
} from '../lib/search.js';
import './catalog.css';

/** Public product search. The URL holds the filters, so results can be shared and bookmarked. */
export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  return (
    <>
      <h1>Search</h1>
      {/* Keyed on the URL: the form is re-created (and re-seeded) whenever the filters change. */}
      <SearchForm
        key={params.toString()}
        filters={filters}
        onApply={(next) => setParams(toUrlParams({ ...next, page: 1 }))}
      />
      <Results filters={filters} onPage={(page) => setParams(toUrlParams({ ...filters, page }))} />
    </>
  );
}

function SearchForm({ filters, onApply }) {
  const [draft, setDraft] = useState(filters);
  const set = (field) => (event) =>
    setDraft((d) => ({
      ...d,
      [field]: event.target.type === 'checkbox' ? event.target.checked : event.target.value,
    }));

  const { data: tree = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: async () => (await apiFetch('/categories')).data,
    staleTime: 5 * 60_000,
  });

  return (
    <form
      className="filters"
      onSubmit={(event) => {
        event.preventDefault();
        onApply(draft);
      }}
    >
      <label>
        Search
        <input type="search" value={draft.q} onChange={set('q')} maxLength={100} />
      </label>
      <label>
        Category
        <select value={draft.category} onChange={set('category')}>
          <option value="">All categories</option>
          {flattenCategories(tree).map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Min price (₹)
        <input inputMode="decimal" value={draft.min} onChange={set('min')} size={8} />
      </label>
      <label>
        Max price (₹)
        <input inputMode="decimal" value={draft.max} onChange={set('max')} size={8} />
      </label>
      <label>
        Sort by
        <select value={draft.sort} onChange={set('sort')}>
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="inline">
        <input type="checkbox" checked={draft.inStock} onChange={set('inStock')} /> In stock only
      </label>
      <button type="submit">Search</button>
    </form>
  );
}

function Results({ filters, onPage }) {
  const apiQuery = toApiQuery(filters);
  const { data, error, isPending, isFetching } = useQuery({
    queryKey: ['search', apiQuery],
    queryFn: () => apiFetch(`/products/search?${apiQuery}`),
    retry: false,
    placeholderData: (previous) => previous, // keep the old page visible while the next loads
  });

  if (isPending) return <p>Searching…</p>;
  if (error) {
    return (
      <p role="alert">
        {error.status === 429
          ? 'Too many searches, please wait a moment and try again.'
          : error.status === 422
            ? 'Those filters are not valid. Check the prices and try again.'
            : error.message}
      </p>
    );
  }

  const { data: items, meta } = data;
  if (items.length === 0) return <p>No products match your search.</p>;

  return (
    <section aria-busy={isFetching}>
      <p className="muted">
        {meta.total} {meta.total === 1 ? 'product' : 'products'}
      </p>
      <ul className="product-grid">
        {items.map((p) => (
          <li key={p.id}>
            <Link to={`/products/${p.slug}`} className="product-card">
              {p.imageUrl ? (
                <img src={p.imageUrl} alt="" loading="lazy" />
              ) : (
                <div className="no-image" />
              )}
              <strong>{p.title}</strong>
              <span>{formatINR(p.pricePaise)}</span>
              <span className="muted">
                {p.shop.name}
                {p.ratingCount > 0 && ` · ★ ${p.ratingAvg.toFixed(1)} (${p.ratingCount})`}
              </span>
              {!p.inStock && <span className="badge suspended">Out of stock</span>}
            </Link>
          </li>
        ))}
      </ul>
      <nav className="pager" aria-label="Pages">
        <button type="button" disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)}>
          Previous
        </button>
        <span>
          Page {meta.page} of {meta.totalPages}
        </span>
        <button
          type="button"
          disabled={meta.page >= meta.totalPages}
          onClick={() => onPage(meta.page + 1)}
        >
          Next
        </button>
      </nav>
    </section>
  );
}