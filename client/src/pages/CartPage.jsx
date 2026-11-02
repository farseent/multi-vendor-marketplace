import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../lib/api.js';
import { CART_KEY, couponReasonMessage, fetchCart, lineNotice, MAX_QUANTITY } from '../lib/cart.js';
import { formatINR } from '../lib/money.js';
import './cart.css';

/** The customer's cart: priced preview from the API, quantity edits and a coupon box. */
export default function CartPage() {
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const { data: cart, error, isPending } = useQuery({ queryKey: CART_KEY, queryFn: fetchCart });

  // Every cart endpoint answers with the whole priced cart, so a change just replaces the cache.
  const change = useMutation({
    mutationFn: ({ method, path, body }) => apiFetch(path, { method, body }),
    onSuccess: ({ data }) => queryClient.setQueryData(CART_KEY, data),
  });
  const run = (method, path, body, options) => change.mutate({ method, path, body }, options);

  if (isPending) return <p>Loading…</p>;
  if (error) return <p role="alert">{error.message}</p>;

  const couponMessage =
    change.error?.code === 'COUPON_INVALID'
      ? couponReasonMessage(change.error.details?.reason)
      : null;
  const otherError = change.error && !couponMessage ? change.error.message : null;

  if (cart.items.length === 0) {
    return (
      <section>
        <h1>Your cart</h1>
        <p>Your cart is empty.</p>
        <p>
          <Link to="/search">Browse products</Link>
        </p>
      </section>
    );
  }

  return (
    <section>
      <div className="toolbar">
        <h1>Your cart</h1>
        <button type="button" disabled={change.isPending} onClick={() => run('DELETE', '/cart')}>
          Empty cart
        </button>
      </div>
      {otherError && <p role="alert">{otherError}</p>}
      {cart.hasIssues && (
        <p className="notice" role="status">
          Some items need attention before you can check out.
        </p>
      )}

      <ul className="cart-lines">
        {cart.items.map((line) => {
          const notice = lineNotice(line);
          const unavailable = line.status === 'unavailable';
          return (
            <li key={line.productId} className="cart-line">
              {line.imageUrl && <img src={line.imageUrl} alt="" width="64" height="64" />}
              <div className="cart-line-info">
                {line.slug ? (
                  <Link to={`/products/${line.slug}`}>{line.title}</Link>
                ) : (
                  <span>{line.title ?? 'Unavailable product'}</span>
                )}
                {line.shop && <small>Sold by {line.shop.name}</small>}
                {notice && (
                  <small className="cart-warning" role="status">
                    {notice}
                  </small>
                )}
              </div>
              {!unavailable && (
                <>
                  <span>{formatINR(line.unitPricePaise)}</span>
                  <label>
                    <span className="visually-hidden">Quantity for {line.title}</span>
                    <select
                      value={line.quantity}
                      disabled={change.isPending}
                      onChange={(event) =>
                        run('PUT', `/cart/items/${line.productId}`, {
                          quantity: Number(event.target.value),
                        })
                      }
                    >
                      {Array.from({ length: MAX_QUANTITY }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                  <strong>{formatINR(line.lineNetPaise)}</strong>
                </>
              )}
              <button
                type="button"
                disabled={change.isPending}
                onClick={() => run('DELETE', `/cart/items/${line.productId}`)}
              >
                Remove
              </button>
            </li>
          );
        })}
      </ul>

      <div className="cart-summary">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (code.trim())
              run('POST', '/cart/coupon', { code }, { onSuccess: () => setCode('') });
          }}
        >
          <label>
            Coupon code{' '}
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              maxLength={40}
              autoComplete="off"
            />
          </label>{' '}
          <button type="submit" disabled={change.isPending || !code.trim()}>
            Apply
          </button>
          {couponMessage && <p role="alert">{couponMessage}</p>}
        </form>

        {cart.coupon && (
          <p>
            Coupon <strong>{cart.coupon.code}</strong> applied.{' '}
            <button
              type="button"
              disabled={change.isPending}
              onClick={() => run('DELETE', '/cart/coupon')}
            >
              Remove
            </button>
          </p>
        )}
        {cart.couponError && (
          <p role="alert">
            Coupon <strong>{cart.couponError.code}</strong>:{' '}
            {couponReasonMessage(cart.couponError.reason)}{' '}
            <button
              type="button"
              disabled={change.isPending}
              onClick={() => run('DELETE', '/cart/coupon')}
            >
              Remove
            </button>
          </p>
        )}

        <dl className="cart-totals">
          <dt>Subtotal</dt>
          <dd>{formatINR(cart.subtotalPaise)}</dd>
          {cart.discountPaise > 0 && (
            <>
              <dt>Discount</dt>
              <dd>−{formatINR(cart.discountPaise)}</dd>
            </>
          )}
          <dt>Shipping</dt>
          <dd>Free</dd>
          <dt>Total</dt>
          <dd>
            <strong>{formatINR(cart.totalPaise)}</strong>
          </dd>
        </dl>
        <p>
          <small>Prices and stock are confirmed again when you check out.</small>
        </p>
        {cart.hasIssues ? (
          <p>
            <button type="button" disabled>
              Proceed to checkout
            </button>{' '}
            <small>Fix the items above first.</small>
          </p>
        ) : (
          <p>
            <Link to="/checkout" className="button-link">
              Proceed to checkout
            </Link>
          </p>
        )}
      </div>
    </section>
  );
}
