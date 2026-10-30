import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { apiFetch } from '../lib/api.js';
import { formatINR } from '../lib/money.js';
import './catalog.css';

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

  if (isPending) return <p>Loading…</p>;
  if (error) {
    return (
      <p role="alert">
        {error.status === 404 || error.status === 422
          ? 'This product is not available.'
          : error.message}{' '}
        <Link to="/">Back to home</Link>
      </p>
    );
  }

  const attributes = Object.entries(product.attributes);
  return (
    <article>
      <h1>{product.title}</h1>
      <p>Sold by {product.shop.name}</p>
      <div className="product-gallery">
        {product.images.map((img) => (
          <img key={img.url} src={img.url} alt={img.alt ?? product.title} />
        ))}
      </div>
      <p>
        <strong>{formatINR(product.pricePaise)}</strong>
        {product.compareAtPricePaise && (
          <span className="price-was">{formatINR(product.compareAtPricePaise)}</span>
        )}
      </p>
      <p>{product.inStock ? 'In stock' : 'Out of stock'}</p>
      {product.description && <p>{product.description}</p>}
      {attributes.length > 0 && (
        <dl className="attributes">
          {attributes.map(([name, value]) => (
            <div key={name} style={{ display: 'contents' }}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}
