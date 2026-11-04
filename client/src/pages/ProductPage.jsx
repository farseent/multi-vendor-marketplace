import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import AddToCart from '../components/AddToCart.jsx';
import ReviewsSection from '../components/ReviewsSection.jsx';
import { Badge, Card, Container, ErrorState, Icon, LinkButton, Skeleton, Stars } from '../components/ui';
import { cx } from '../components/ui/classes.js';
import { apiFetch } from '../lib/api.js';
import { formatINR } from '../lib/money.js';
import { ratingSummaryText } from '../lib/reviews.js';

function Gallery({ images, title }) {
  const [index, setIndex] = useState(0);
  if (images.length === 0) {
    return (
      <div className="grid aspect-square place-items-center rounded-2xl border border-slate-200 bg-slate-100 text-slate-300">
        <Icon name="image" className="size-16" />
      </div>
    );
  }
  const current = images[Math.min(index, images.length - 1)];
  return (
    <div>
      <div className="aspect-square overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <img src={current.url} alt={current.alt ?? title} className="size-full object-contain" />
      </div>
      {images.length > 1 && (
        <ul className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="Product images">
          {images.map((img, i) => (
            <li key={img.url} className="shrink-0">
              <button
                type="button"
                onClick={() => setIndex(i)}
                aria-label={`Show image ${i + 1} of ${images.length}`}
                aria-current={i === index}
                className={cx(
                  'size-16 overflow-hidden rounded-lg border-2 bg-white transition-colors sm:size-20',
                  i === index ? 'border-brand-600' : 'border-transparent hover:border-slate-300',
                )}
              >
                <img src={img.url} alt="" className="size-full object-cover" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProductSkeleton() {
  return (
    <Container className="py-8" aria-hidden="true">
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <Skeleton className="aspect-square rounded-2xl" />
        <div className="space-y-4">
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-10 w-1/4" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    </Container>
  );
}

/** Public product page: no login needed. Draft, archived or unapproved-shop products are 404. */
export default function ProductPage() {
  const { slug } = useParams();
  const {
    data: product,
    error,
    isPending,
  } = useQuery({
    queryKey: ['product', slug],
    queryFn: async () => (await apiFetch(`/products/${slug}`)).data,
    retry: false,
  });

  if (isPending) return <ProductSkeleton />;
  if (error) {
    return (
      <Container narrow className="py-16">
        <ErrorState
          title="This product is not available"
          message={
            error.status === 404 || error.status === 422
              ? 'It may have been removed or is not on sale right now.'
              : error.message
          }
          action={<LinkButton to="/">Back to home</LinkButton>}
        />
      </Container>
    );
  }

  const attributes = Object.entries(product.attributes);
  const discount = product.compareAtPricePaise
    ? Math.round(((product.compareAtPricePaise - product.pricePaise) / product.compareAtPricePaise) * 100)
    : 0;

  return (
    <Container className="py-8 sm:py-10">
      <nav aria-label="Breadcrumb" className="mb-5 text-sm text-slate-500">
        <ol className="flex flex-wrap items-center gap-1.5">
          <li>
            <Link to="/" className="hover:text-brand-700">
              Home
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link to="/search" className="hover:text-brand-700">
              Products
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="max-w-xs truncate text-slate-700">
            {product.title}
          </li>
        </ol>
      </nav>

      <article className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-12">
        <Gallery key={product.id} images={product.images} title={product.title} />

        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
            {product.title}
          </h1>
          <p className="mt-2 flex items-center gap-2 text-sm text-slate-600">
            <Icon name="store" className="size-4 text-slate-400" />
            Sold by <span className="font-medium text-slate-900">{product.shop.name}</span>
          </p>
          <a href="#reviews" className="mt-3 flex items-center gap-2 text-sm text-slate-600 hover:text-brand-700">
            {product.ratingCount > 0 && <Stars rating={product.ratingAvg.toFixed(1)} />}
            {ratingSummaryText(product.ratingAvg, product.ratingCount)}
          </a>

          <div className="mt-5 flex flex-wrap items-baseline gap-3">
            <p className="tabular text-3xl font-semibold text-slate-900">
              {formatINR(product.pricePaise)}
            </p>
            {product.compareAtPricePaise && (
              <p className="tabular text-lg text-slate-500">
                <span className="sr-only">Was </span>
                <s>{formatINR(product.compareAtPricePaise)}</s>
              </p>
            )}
            {discount > 0 && <Badge tone="success">Save {discount}%</Badge>}
          </div>

          <p className="mt-4">
            {product.inStock ? (
              <Badge tone="success">In stock</Badge>
            ) : (
              <Badge tone="danger">Out of stock</Badge>
            )}
          </p>

          <div className="mt-6">
            <AddToCart product={product} />
          </div>

          <p className="mt-6 flex items-center gap-2 text-sm text-slate-600">
            <Icon name="truck" className="size-4.5 text-slate-400" />
            Free shipping on every order
          </p>

          {product.description && (
            <section className="mt-8" aria-labelledby="description-heading">
              <h2 id="description-heading" className="text-base font-semibold text-slate-900">
                About this product
              </h2>
              <p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-700">
                {product.description}
              </p>
            </section>
          )}

          {attributes.length > 0 && (
            <section className="mt-8" aria-labelledby="details-heading">
              <h2 id="details-heading" className="mb-3 text-base font-semibold text-slate-900">
                Details
              </h2>
              <Card padded={false}>
                <dl className="divide-y divide-slate-100 text-sm">
                  {attributes.map(([name, value]) => (
                    <div key={name} className="grid grid-cols-3 gap-4 px-4 py-3">
                      <dt className="text-slate-500 capitalize">{name}</dt>
                      <dd className="col-span-2 text-slate-900">{value}</dd>
                    </div>
                  ))}
                </dl>
              </Card>
            </section>
          )}
        </div>
      </article>

      <ReviewsSection product={product} />
    </Container>
  );
}