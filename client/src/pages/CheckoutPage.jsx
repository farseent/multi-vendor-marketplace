import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/api.js';
import { CART_KEY, fetchCart } from '../lib/cart.js';
import {
  ADDRESSES_KEY,
  canReuseKey,
  checkoutErrorMessage,
  fetchAddresses,
  newIdempotencyKey,
} from '../lib/checkout.js';
import { formatINR } from '../lib/money.js';
import './orders.css';

const EMPTY_ADDRESS = {
  label: 'Home',
  name: '',
  phone: '',
  line1: '',
  city: '',
  state: '',
  postalCode: '',
};

/** A small form so a customer without a saved address can still check out. */
function AddAddressForm({ onSaved }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY_ADDRESS);
  const save = useMutation({
    mutationFn: () =>
      apiFetch('/users/me/addresses', {
        method: 'POST',
        body: { ...form, isDefault: true },
      }),
    onSuccess: async ({ data }) => {
      await queryClient.invalidateQueries({ queryKey: ADDRESSES_KEY });
      onSaved(data.id);
    },
  });
  const set = (field) => (event) => setForm({ ...form, [field]: event.target.value });
  const fields = [
    ['name', 'Full name'],
    ['phone', 'Phone (e.g. +919876543210)'],
    ['line1', 'Address'],
    ['city', 'City'],
    ['state', 'State'],
    ['postalCode', 'PIN code (6 digits)'],
  ];
  return (
    <form
      className="address-form"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      {fields.map(([field, label]) => (
        <label key={field}>
          {label}
          <input value={form[field]} onChange={set(field)} required />
        </label>
      ))}
      {save.error && <p role="alert">{save.error.message}</p>}
      <button type="submit" disabled={save.isPending}>
        Save address
      </button>
    </form>
  );
}

/** Step 1 of buying: pick an address and place the order. Payment happens on the order page. */
export default function CheckoutPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const cartQuery = useQuery({ queryKey: CART_KEY, queryFn: fetchCart });
  const addressesQuery = useQuery({ queryKey: ADDRESSES_KEY, queryFn: fetchAddresses });
  const [chosen, setChosen] = useState('');
  const [adding, setAdding] = useState(false);
  // One key per attempt: a double click or a retry after a dropped connection cannot create a
  // second order. It is replaced only after the server has given a definite answer.
  const keyRef = useRef(newIdempotencyKey());

  const place = useMutation({
    mutationFn: (addressId) =>
      apiFetch('/checkout', {
        method: 'POST',
        body: { addressId },
        headers: { 'Idempotency-Key': keyRef.current },
      }),
    onSuccess: ({ data }) => {
      queryClient.invalidateQueries({ queryKey: CART_KEY });
      navigate(`/orders/${data.order.id}`, { state: { autoPay: true } });
    },
    onError: (error) => {
      if (!canReuseKey(error)) keyRef.current = newIdempotencyKey();
    },
  });

  if (cartQuery.isPending || addressesQuery.isPending) return <p>Loading…</p>;
  if (cartQuery.error || addressesQuery.error) {
    return <p role="alert">{(cartQuery.error ?? addressesQuery.error).message}</p>;
  }
  const cart = cartQuery.data;
  const addresses = addressesQuery.data;
  if (cart.items.length === 0) {
    return (
      <section>
        <h1>Checkout</h1>
        <p>Your cart is empty.</p>
        <Link to="/search">Browse products</Link>
      </section>
    );
  }

  const selected = chosen || addresses.find((a) => a.isDefault)?.id || addresses[0]?.id || '';
  const blocked = cart.hasIssues;

  return (
    <section>
      <h1>Checkout</h1>
      {blocked && (
        <p className="notice" role="status">
          Some items in your cart need attention. <Link to="/cart">Fix your cart</Link>
        </p>
      )}
      <h2>Delivery address</h2>
      {addresses.length > 0 && !adding && (
        <>
          <ul className="address-list">
            {addresses.map((address) => (
              <li key={address.id}>
                <label>
                  <input
                    type="radio"
                    name="address"
                    value={address.id}
                    checked={selected === address.id}
                    onChange={() => setChosen(address.id)}
                  />{' '}
                  <strong>{address.name}</strong>, {address.line1}, {address.city}, {address.state}{' '}
                  {address.postalCode}
                </label>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => setAdding(true)}>
            Add another address
          </button>
        </>
      )}
      {(addresses.length === 0 || adding) && (
        <AddAddressForm
          onSaved={(id) => {
            setChosen(id);
            setAdding(false);
          }}
        />
      )}
      <h2>Order summary</h2>
      <dl className="cart-totals">
        <dt>Subtotal</dt>
        <dd>{formatINR(cart.subtotalPaise)}</dd>
        {cart.discountPaise > 0 && (
          <>
            <dt>Discount{cart.coupon ? ` (${cart.coupon.code})` : ''}</dt>
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
        <small>
          Stock is held for you for 15 minutes once you place the order. Prices and your coupon are
          checked again now.
        </small>
      </p>
      {place.error && <p role="alert">{checkoutErrorMessage(place.error)}</p>}
      <button
        type="button"
        disabled={place.isPending || blocked || !selected}
        onClick={() => place.mutate(selected)}
      >
        {place.isPending ? 'Placing order…' : 'Place order'}
      </button>{' '}
      <Link to="/cart">Back to cart</Link>
    </section>
  );
}
