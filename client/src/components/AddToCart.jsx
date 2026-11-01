import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { apiFetch } from '../lib/api.js';
import { CART_KEY, fetchCart, MAX_QUANTITY, roomLeft } from '../lib/cart.js';

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
      <p>
        <Link to="/login" state={{ from: `/products/${product.slug}` }}>
          Log in
        </Link>{' '}
        to add this to your cart.
      </p>
    );
  }
  if (!isCustomer) return null;

  const room = roomLeft(inCart);
  return (
    <div className="add-to-cart">
      {room === 0 ? (
        <p>
          You already have the maximum ({MAX_QUANTITY}) in your cart.{' '}
          <Link to="/cart">View cart</Link>
        </p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate();
          }}
        >
          <label>
            Quantity{' '}
            <select
              value={Math.min(quantity, room)}
              onChange={(event) => setQuantity(Number(event.target.value))}
            >
              {Array.from({ length: room }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>{' '}
          <button type="submit" disabled={add.isPending}>
            {add.isPending ? 'Adding…' : 'Add to cart'}
          </button>
        </form>
      )}
      {add.isSuccess && (
        <p role="status">
          Added. <Link to="/cart">View cart</Link>
        </p>
      )}
      {add.error && <p role="alert">{add.error.message}</p>}
    </div>
  );
}
