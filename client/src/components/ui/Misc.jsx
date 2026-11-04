import { Link, useNavigate } from 'react-router-dom';
import { formatINR } from '../../lib/money.js';
import { Button } from './Button.jsx';
import { Badge } from './Badge.jsx';
import Icon from './Icon.jsx';
import { cx, inputClasses } from './classes.js';

/** Page-width wrapper. Pages (not the layout) choose it so full-bleed sections stay possible. */
export const Container = ({ narrow = false, className, children }) => (
  <div
    className={cx(
      'mx-auto w-full px-4 sm:px-6 lg:px-8',
      narrow ? 'max-w-3xl' : 'max-w-7xl',
      className,
    )}
  >
    {children}
  </div>
);

/** Headline figure with a label (dashboards). */
export function StatCard({ label, value, hint, icon }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-slate-500">{label}</p>
        {icon && (
          <span className="grid size-9 place-items-center rounded-lg bg-brand-50 text-brand-600">
            <Icon name={icon} className="size-5" />
          </span>
        )}
      </div>
      <p className="tabular mt-2 text-2xl font-semibold tracking-tight text-slate-900">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

/** Five stars for a rating; announced as text for screen readers. */
export function Stars({ rating, className }) {
  const filled = Math.round(Number(rating) || 0);
  return (
    <span
      className={cx('inline-flex items-center gap-0.5', className)}
      role="img"
      aria-label={`${rating} out of 5 stars`}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <Icon
          key={n}
          name="star"
          filled
          className={cx('size-4', n <= filled ? 'text-amber-400' : 'text-slate-200')}
        />
      ))}
    </span>
  );
}

/** One product in a grid (search results, home page). `product` is a /products/search item. */
export function ProductCard({ product: p }) {
  return (
    <Link
      to={`/products/${p.slug}`}
      className="group flex h-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card transition hover:border-slate-300 hover:shadow-md"
    >
      <div className="relative aspect-square overflow-hidden bg-slate-100">
        {p.imageUrl ? (
          <img
            src={p.imageUrl}
            alt=""
            loading="lazy"
            className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="grid size-full place-items-center text-slate-300">
            <Icon name="image" className="size-10" />
          </div>
        )}
        {!p.inStock && (
          <span className="absolute left-2 top-2">
            <Badge tone="danger" className="bg-white/95">
              Out of stock
            </Badge>
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3 sm:p-4">
        <h3 className="line-clamp-2 text-sm font-medium text-slate-900 group-hover:text-brand-700">
          {p.title}
        </h3>
        <p className="truncate text-xs text-slate-500">{p.shop.name}</p>
        {p.ratingCount > 0 && (
          <p className="flex items-center gap-1 text-xs text-slate-600">
            <Icon name="star" filled className="size-3.5 text-amber-400" />
            <span className="font-medium">{p.ratingAvg.toFixed(1)}</span>
            <span className="text-slate-400">({p.ratingCount})</span>
            <span className="sr-only">
              Rated {p.ratingAvg.toFixed(1)} out of 5 from {p.ratingCount} reviews
            </span>
          </p>
        )}
        <p className="tabular mt-auto pt-2 text-base font-semibold text-slate-900">
          {formatINR(p.pricePaise)}
        </p>
      </div>
    </Link>
  );
}

/** Product search box: sends the visitor to /search?q=… `className` replaces the default `flex`. */
export function SearchBar({ className, defaultValue = '', large = false }) {
  const navigate = useNavigate();
  return (
    <form
      role="search"
      className={className ?? 'flex'}
      onSubmit={(event) => {
        event.preventDefault();
        const q = new FormData(event.currentTarget).get('q').toString().trim();
        navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
      }}
    >
      <div className="relative flex-1">
        <Icon
          name="search"
          className="pointer-events-none absolute left-3 top-1/2 size-4.5 -translate-y-1/2 text-slate-400"
        />
        <input
          name="q"
          type="search"
          defaultValue={defaultValue}
          placeholder="Search products"
          aria-label="Search products"
          maxLength={100}
          className={cx(inputClasses, 'rounded-r-none border-r-0 pl-10', large && 'min-h-12 sm:min-h-12')}
        />
      </div>
      <Button type="submit" size={large ? 'lg' : 'md'} className="rounded-l-none">
        Search
      </Button>
    </form>
  );
}

/** Rows of "label … amount" used by the cart, checkout and order summaries. */
export function OrderTotals({ rows, total }) {
  return (
    <dl className="space-y-2.5 text-sm">
      {rows.map(([label, value, tone]) => (
        <div key={label} className="flex justify-between gap-4">
          <dt className="text-slate-600">{label}</dt>
          <dd className={cx('tabular font-medium', tone === 'success' ? 'text-emerald-700' : 'text-slate-900')}>
            {value}
          </dd>
        </div>
      ))}
      <div className="flex justify-between gap-4 border-t border-slate-200 pt-3 text-base">
        <dt className="font-semibold text-slate-900">Total</dt>
        <dd className="tabular font-semibold text-slate-900">{total}</dd>
      </div>
    </dl>
  );
}