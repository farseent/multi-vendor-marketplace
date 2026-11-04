import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  Container,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Input,
  LinkButton,
  OrderTotals,
  PageHeader,
  PageLoading,
  Select,
} from '../components/ui';
import { cx, linkClasses } from '../components/ui/classes.js';
import { apiFetch } from '../lib/api.js';
import { CART_KEY, couponReasonMessage, fetchCart, lineNotice, MAX_QUANTITY } from '../lib/cart.js';
import { formatINR } from '../lib/money.js';

/** The customer's cart: priced preview from the API, quantity edits and a coupon box. */
export default function CartPage() {
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const { data: cart, error, isPending } = useQuery({ queryKey: CART_KEY, queryFn: fetchCart });

  // Every cart endpoint answers with the whole priced cart, so a change just replaces the cache.
  const change = useMutation({
    mutationFn: ({ method, path, body }) => apiFetch(path, { method, body }),
    onSuccess: ({ data }) => queryClient.setQueryData(CART_KEY, data),
  });
  const run = (method, path, body, options) => change.mutate({ method, path, body }, options);

  if (isPending) return <PageLoading />;
  if (error) {
    return (
      <Container narrow className="py-12">
        <ErrorState message={error.message} />
      </Container>
    );
  }

  const couponMessage =
    change.error?.code === 'COUPON_INVALID'
      ? couponReasonMessage(change.error.details?.reason)
      : null;
  const otherError = change.error && !couponMessage ? change.error.message : null;

  if (cart.items.length === 0) {
    return (
      <Container narrow className="py-12 sm:py-16">
        <EmptyState
          icon="cart"
          title="Your cart is empty"
          description="Find something you like and add it to your cart."
          action={<LinkButton to="/search">Browse products</LinkButton>}
        />
      </Container>
    );
  }

  return (
    <Container className="py-8 sm:py-10">
      <PageHeader
        title="Your cart"
        description={`${cart.itemCount} ${cart.itemCount === 1 ? 'item' : 'items'}`}
        actions={
          <Button
            variant="secondary"
            size="sm"
            disabled={change.isPending}
            onClick={() => setConfirmEmpty(true)}
          >
            <Icon name="trash" className="size-4" />
            Empty cart
          </Button>
        }
      />
      <div className="space-y-3">
        {otherError && <Alert tone="danger">{otherError}</Alert>}
        {cart.hasIssues && (
          <Alert tone="warning">Some items need attention before you can check out.</Alert>
        )}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <Card padded={false}>
          <ul className="divide-y divide-slate-100">
            {cart.items.map((line) => {
              const notice = lineNotice(line);
              const unavailable = line.status === 'unavailable';
              return (
                <li key={line.productId} className="flex gap-4 p-4 sm:p-5">
                  <div className="size-20 shrink-0 overflow-hidden rounded-lg bg-slate-100 sm:size-24">
                    {line.imageUrl ? (
                      <img src={line.imageUrl} alt="" className="size-full object-cover" />
                    ) : (
                      <div className="grid size-full place-items-center text-slate-300">
                        <Icon name="image" className="size-8" />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                      <div className="min-w-0">
                        {line.slug ? (
                          <Link
                            to={`/products/${line.slug}`}
                            className="line-clamp-2 font-medium text-slate-900 hover:text-brand-700"
                          >
                            {line.title}
                          </Link>
                        ) : (
                          <span className="font-medium text-slate-500">
                            {line.title ?? 'Unavailable product'}
                          </span>
                        )}
                        {line.shop && (
                          <p className="text-xs text-slate-500">Sold by {line.shop.name}</p>
                        )}
                      </div>
                      {!unavailable && (
                        <p className="tabular font-semibold text-slate-900">
                          {formatINR(line.lineNetPaise)}
                        </p>
                      )}
                    </div>
                    {notice && (
                      <p
                        role="status"
                        className="mt-2 flex items-start gap-1.5 text-xs font-medium text-red-700"
                      >
                        <Icon name="alert-circle" className="mt-px size-4" />
                        {notice}
                      </p>
                    )}
                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                      {!unavailable && (
                        <>
                          <label className="flex items-center gap-2 text-sm text-slate-600">
                            <span className="sr-only">Quantity for {line.title}</span>
                            <span aria-hidden="true">Qty</span>
                            <Select
                              className="w-20"
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
                            </Select>
                          </label>
                          <span className="tabular text-sm text-slate-500">
                            {formatINR(line.unitPricePaise)} each
                          </span>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto text-red-700 hover:bg-red-50 hover:text-red-800"
                        disabled={change.isPending}
                        onClick={() => run('DELETE', `/cart/items/${line.productId}`)}
                        aria-label={`Remove ${line.title ?? 'item'} from cart`}
                      >
                        <Icon name="trash" className="size-4" />
                        Remove
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card as="aside" aria-label="Order summary" className="space-y-5 lg:sticky lg:top-24">
          <h2 className="text-base font-semibold text-slate-900">Order summary</h2>

          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (code.trim())
                run('POST', '/cart/coupon', { code }, { onSuccess: () => setCode('') });
            }}
          >
            <Field label="Coupon code">
              <div className="flex gap-2">
                <Input
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  maxLength={40}
                  autoComplete="off"
                  aria-invalid={Boolean(couponMessage)}
                />
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={change.isPending || !code.trim()}
                >
                  Apply
                </Button>
              </div>
            </Field>
            {couponMessage && <Alert tone="danger">{couponMessage}</Alert>}
          </form>

          {cart.coupon && (
            <Alert tone="success">
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  Coupon <strong>{cart.coupon.code}</strong> applied.
                </span>
                <button
                  type="button"
                  disabled={change.isPending}
                  onClick={() => run('DELETE', '/cart/coupon')}
                  className={cx(linkClasses, 'disabled:opacity-50')}
                >
                  Remove
                </button>
              </span>
            </Alert>
          )}
          {cart.couponError && (
            <Alert tone="danger">
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  Coupon <strong>{cart.couponError.code}</strong>:{' '}
                  {couponReasonMessage(cart.couponError.reason)}
                </span>
                <button
                  type="button"
                  disabled={change.isPending}
                  onClick={() => run('DELETE', '/cart/coupon')}
                  className={cx(linkClasses, 'disabled:opacity-50')}
                >
                  Remove
                </button>
              </span>
            </Alert>
          )}

          <OrderTotals
            rows={[
              ['Subtotal', formatINR(cart.subtotalPaise)],
              ...(cart.discountPaise > 0
                ? [['Discount', `\u2212${formatINR(cart.discountPaise)}`, 'success']]
                : []),
              ['Shipping', 'Free'],
            ]}
            total={formatINR(cart.totalPaise)}
          />
          <p className="text-xs text-slate-500">
            Prices and stock are confirmed again when you check out.
          </p>
          {cart.hasIssues ? (
            <div className="space-y-2">
              <Button size="lg" className="w-full" disabled>
                Proceed to checkout
              </Button>
              <p className="text-center text-xs text-slate-500">Fix the items above first.</p>
            </div>
          ) : (
            <LinkButton to="/checkout" size="lg" className="w-full">
              Proceed to checkout
            </LinkButton>
          )}
        </Card>
      </div>

      <ConfirmDialog
        open={confirmEmpty}
        title="Empty your cart?"
        message="All items will be removed from your cart."
        confirmLabel="Empty cart"
        pending={change.isPending}
        onConfirm={() =>
          run('DELETE', '/cart', undefined, { onSettled: () => setConfirmEmpty(false) })
        }
        onCancel={() => setConfirmEmpty(false)}
      />
    </Container>
  );
}
