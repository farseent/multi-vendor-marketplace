import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button,
  Card,
  Checkbox,
  Container,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Input,
  LinkButton,
  PageHeader,
  Pagination,
  ProductCard,
  Select,
  Skeleton,
} from '../components/ui';
import { productGridClasses } from '../components/ui/classes.js';
import { apiFetch } from '../lib/api.js';
import {
  SORT_OPTIONS,
  flattenCategories,
  readFilters,
  toApiQuery,
  toUrlParams,
} from '../lib/search.js';

/** Public product search. The URL holds the filters, so results can be shared and bookmarked. */
export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filters = readFilters(params);
  return (
    <Container className="py-8 sm:py-10">
      <PageHeader
        title={filters.q ? `Results for \u201c${filters.q}\u201d` : 'Browse products'}
        description="Search the catalog, then narrow it down by category, price and availability."
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[17rem_minmax(0,1fr)] lg:items-start">
        <aside aria-label="Filters" className="lg:sticky lg:top-24">
          <Button
            variant="secondary"
            className="w-full lg:hidden"
            aria-expanded={filtersOpen}
            aria-controls="search-filters"
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <Icon name="filter" className="size-4" />
            {filtersOpen ? 'Hide filters' : 'Show filters'}
          </Button>
          <div id="search-filters" className={filtersOpen ? 'mt-3 lg:mt-0' : 'hidden lg:block'}>
            {/* Keyed on the URL: the form is re-created (and re-seeded) whenever the filters change. */}
            <SearchForm
              key={params.toString()}
              filters={filters}
              onApply={(next) => setParams(toUrlParams({ ...next, page: 1 }))}
            />
          </div>
        </aside>
        <Results
          filters={filters}
          onPage={(page) => setParams(toUrlParams({ ...filters, page }))}
        />
      </div>
    </Container>
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
    <Card as="form" className="space-y-4" onSubmit={(event) => {
      event.preventDefault();
      onApply(draft);
    }}>
      <Field label="Search">
        <Input type="search" value={draft.q} onChange={set('q')} maxLength={100} />
      </Field>
      <Field label="Category">
        <Select value={draft.category} onChange={set('category')}>
          <option value="">All categories</option>
          {flattenCategories(tree).map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Min price (₹)">
          <Input inputMode="decimal" value={draft.min} onChange={set('min')} />
        </Field>
        <Field label="Max price (₹)">
          <Input inputMode="decimal" value={draft.max} onChange={set('max')} />
        </Field>
      </div>
      <Field label="Sort by">
        <Select value={draft.sort} onChange={set('sort')}>
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      <Checkbox label="In stock only" checked={draft.inStock} onChange={set('inStock')} />
      <Button type="submit" className="w-full">
        <Icon name="search" className="size-4" />
        Apply
      </Button>
    </Card>
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

  if (isPending) {
    return (
      <div role="status" aria-label="Searching…" className={productGridClasses}>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <Skeleton className="aspect-square rounded-none" />
            <div className="space-y-2 p-4">
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-5 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <ErrorState
        title="We could not load the results"
        message={
          error.status === 429
            ? 'Too many searches, please wait a moment and try again.'
            : error.status === 422
              ? 'Those filters are not valid. Check the prices and try again.'
              : error.message
        }
      />
    );
  }

  const { data: items, meta } = data;
  if (items.length === 0) {
    return (
      <EmptyState
        icon="search"
        title="No products match your search"
        description="Try a different word, widen the price range, or clear the filters."
        action={
          <LinkButton to="/search" variant="secondary">
            Clear all filters
          </LinkButton>
        }
      />
    );
  }

  return (
    <section aria-busy={isFetching} className={isFetching ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
      <p className="mb-4 text-sm text-slate-600" aria-live="polite">
        {meta.total} {meta.total === 1 ? 'product' : 'products'}
      </p>
      <ul className={productGridClasses}>
        {items.map((p) => (
          <li key={p.id}>
            <ProductCard product={p} />
          </li>
        ))}
      </ul>
      <Pagination meta={meta} onPage={onPage} />
    </section>
  );
}