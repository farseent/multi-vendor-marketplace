import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { apiFetch } from '../lib/api.js';
import { CART_KEY, fetchCart, MAX_QUANTITY, roomLeft } from '../lib/cart.js';
import { Alert, Button, Icon, Select } from './ui';
import { linkClasses } from './ui/classes.js';

/**
 * "Add to cart" for the public product page. Only customers have a cart (the API answers 403 to
 * other roles), so everyone else sees a login hint or nothing. The API's PUT sets an absolute
 * quantity, so this adds the chosen amount to what is already in the cart (capped at 10).
 */
export default function AddToCart({ product }) {
  const { status, user } = useAuth();
  const queryClient = useQueryClient();
  const [quantity, setQuantity] = useState(1);
  const isCustomer = status === 'authenticated' && user?.role === 'customer';

  const { data: cart } = useQuery({ queryKey: CART_KEY, queryFn: fetchCart, enabled: isCustomer });
  const inCart = cart?.items.find((line) => line.productId === product.id)?.quantity ?? 0;

  const add = useMutation({
    mutationFn: () =>
      apiFetch(`/cart/items/${product.id}`, {
        method: 'PUT',
        body: { quantity: Math.min(MAX_QUANTITY, inCart + quantity) },
      }),
    onSuccess: ({ data }) => queryClient.setQueryData(CART_KEY, data),
  });

  if (!product.inStock) return null;
  if (status === 'anonymous') {
    return (
      <Alert tone="info">
        <Link to="/login" state={{ from: `/products/${product.slug}` }} className={linkClasses}>
          Log in
        </Link>{' '}
        to add this to your cart.
      </Alert>
    );
  }
  if (!isCustomer) return null;

  const room = roomLeft(inCart);
  return (
    <div className="space-y-3">
      {room === 0 ? (
        <Alert tone="warning">
          You already have the maximum ({MAX_QUANTITY}) in your cart.{' '}
          <Link to="/cart" className={linkClasses}>
            View cart
          </Link>
        </Alert>
      ) : (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate();
          }}
        >
          <label className="block w-24">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">Quantity</span>
            <Select
              value={Math.min(quantity, room)}
              onChange={(event) => setQuantity(Number(event.target.value))}
            >
              {Array.from({ length: room }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </label>
          <Button type="submit" size="lg" className="min-w-44 flex-1 sm:flex-none" loading={add.isPending}>
            <Icon name="cart" className="size-5" />
            {add.isPending ? 'Adding…' : 'Add to cart'}
          </Button>
        </form>
      )}
      {add.isSuccess && (
        <Alert tone="success">
          Added to your cart.{' '}
          <Link to="/cart" className={linkClasses}>
            View cart
          </Link>
        </Alert>
      )}
      {add.error && <Alert tone="danger">{add.error.message}</Alert>}
    </div>
  );
}