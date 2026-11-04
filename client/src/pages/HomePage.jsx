import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { Container, Icon, LinkButton, ProductCard, SearchBar, Skeleton } from '../components/ui';
import { productGridClasses } from '../components/ui/classes.js';
import { apiFetch } from '../lib/api.js';

const HIGHLIGHTS = [
  ['truck', 'Free shipping', 'On every order'],
  ['cart', 'One cart, many sellers', 'Pay once at checkout'],
  ['shield', 'Verified reviews', 'Only from customers who received the product'],
  ['refresh', 'Full refund on cancellation', 'Cancel any part that has not shipped'],
];

// Both lists come from the public search API (the same one the search page uses).
function useProductList(key, query) {
  return useQuery({
    queryKey: ['home', key],
    queryFn: async () => (await apiFetch(`/products/search?${query}`)).data,
    retry: false,
    staleTime: 60_000,
  });
}

function SectionHeader({ title, description, to }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">{title}</h2>
        {description && <p className="mt-1 text-sm text-slate-600">{description}</p>}
      </div>
      <Link
        to={to}
        className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-brand-600 hover:text-brand-700"
      >
        View all
        <Icon name="arrow-right" className="size-4" />
      </Link>
    </div>
  );
}

/** Product row for the home page. Renders nothing when the list failed to load or is empty. */
function ProductSection({ title, description, to, query }) {
  const { data, isPending } = query;
  if (!isPending && (!data || data.length === 0)) return null;
  return (
    <section className="py-10">
      <Container>
        <SectionHeader title={title} description={description} to={to} />
        {isPending ? (
          <div className={productGridClasses} aria-hidden="true">
            {Array.from({ length: 4 }, (_, i) => (
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
        ) : (
          <ul className={productGridClasses}>
            {data.map((p) => (
              <li key={p.id}>
                <ProductCard product={p} />
              </li>
            ))}
          </ul>
        )}
      </Container>
    </section>
  );
}

export default function HomePage() {
  const { status } = useAuth();
  const { data: categories = [] } = useQuery({
    queryKey: ['home', 'categories'],
    queryFn: async () => (await apiFetch('/categories')).data,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const newest = useProductList('newest', 'sort=-createdAt&limit=8');
  const topRated = useProductList('top-rated', 'sort=-ratingAvg&limit=4');
  const rated = {
    ...topRated,
    data: topRated.data?.filter((p) => p.ratingCount > 0),
  };
  const mosaic = (newest.data ?? []).filter((p) => p.imageUrl).slice(0, 4);

  return (
    <>
      <section className="bg-brand-950 text-white">
        <Container className="grid items-center gap-10 py-12 sm:py-16 lg:grid-cols-2 lg:py-20">
          <div>
            <p className="text-sm font-semibold text-brand-300">Independent sellers, one checkout</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
              Shop many sellers in a single cart.
            </h1>
            <p className="mt-4 max-w-lg text-base text-brand-100 sm:text-lg">
              Browse products from independent shops, pay once, and follow each seller&rsquo;s
              shipment from your orders page.
            </p>
            <SearchBar large className="mt-8 hidden max-w-xl lg:flex" />
            {categories.length > 0 && (
              <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-brand-200">
                <span>Popular:</span>
                {categories.slice(0, 4).map((c) => (
                  <Link
                    key={c.id}
                    to={`/search?category=${c.id}`}
                    className="font-medium text-white underline-offset-4 hover:underline"
                  >
                    {c.name}
                  </Link>
                ))}
              </p>
            )}
          </div>
          <div className="hidden lg:block">
            {mosaic.length > 0 ? (
              <ul className="grid grid-cols-2 gap-4">
                {mosaic.map((p) => (
                  <li key={p.id}>
                    <Link
                      to={`/products/${p.slug}`}
                      aria-label={p.title}
                      className="block aspect-square overflow-hidden rounded-2xl bg-white/10 ring-1 ring-white/10 transition hover:ring-white/40"
                    >
                      <img src={p.imageUrl} alt="" className="size-full object-cover" />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <div aria-hidden="true" className="grid grid-cols-2 gap-4">
                {['store', 'package', 'truck', 'shield'].map((icon) => (
                  <div
                    key={icon}
                    className="grid aspect-square place-items-center rounded-2xl bg-white/5 text-brand-300 ring-1 ring-white/10"
                  >
                    <Icon name={icon} className="size-12" />
                  </div>
                ))}
              </div>
            )}
          </div>
        </Container>
      </section>

      <section className="border-b border-slate-200 bg-white">
        <Container>
          <ul className="grid grid-cols-1 divide-y divide-slate-100 sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
            {HIGHLIGHTS.map(([icon, title, text]) => (
              <li key={title} className="flex items-center gap-3 py-4 lg:px-5 lg:first:pl-0">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">
                  <Icon name={icon} />
                </span>
                <div>
                  <p className="text-sm font-semibold text-slate-900">{title}</p>
                  <p className="text-xs text-slate-500">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </Container>
      </section>

      {categories.length > 0 && (
        <section className="pt-10">
          <Container>
            <SectionHeader title="Shop by category" to="/search" />
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {categories.slice(0, 8).map((c) => (
                <li key={c.id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-card">
                  <Link
                    to={`/search?category=${c.id}`}
                    className="flex items-center justify-between gap-2 font-semibold text-slate-900 hover:text-brand-700"
                  >
                    {c.name}
                    <Icon name="chevron-right" className="size-4 text-slate-400" />
                  </Link>
                  {c.children?.length > 0 && (
                    <ul className="mt-3 space-y-1.5">
                      {c.children.slice(0, 4).map((child) => (
                        <li key={child.id}>
                          <Link
                            to={`/search?category=${child.id}`}
                            className="text-sm text-slate-600 hover:text-brand-700 hover:underline"
                          >
                            {child.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </Container>
        </section>
      )}

      <ProductSection
        title="New arrivals"
        description="The latest products from our sellers."
        to="/search?sort=-createdAt"
        query={newest}
      />
      <ProductSection
        title="Top rated"
        description="Products customers rate highest."
        to="/search?sort=-ratingAvg"
        query={rated}
      />

      {status === 'anonymous' && (
        <section className="pb-4 pt-6">
          <Container>
            <div className="flex flex-col items-start justify-between gap-5 rounded-2xl bg-brand-50 p-6 sm:flex-row sm:items-center sm:p-8">
              <div>
                <h2 className="text-xl font-semibold text-slate-900">Have something to sell?</h2>
                <p className="mt-1 max-w-xl text-sm text-slate-600">
                  Open a shop, list your products and get paid after delivery. An admin approves
                  every new shop.
                </p>
              </div>
              <LinkButton to="/register-vendor" size="lg">
                Sell on Marketplace
              </LinkButton>
            </div>
          </Container>
        </section>
      )}
    </>
  );
}