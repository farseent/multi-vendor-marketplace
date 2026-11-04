import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
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
} from '../components/ui';
import { linkClasses } from '../components/ui/classes.js';
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

const EMPTY_ADDRESS = {
  label: 'Home',
  name: '',
  phone: '',
  line1: '',
  city: '',
  state: '',
  postalCode: '',
};

const ADDRESS_FIELDS = [
  ['name', 'Full name', 'name', 'sm:col-span-2'],
  ['phone', 'Phone (e.g. +919876543210)', 'tel', 'sm:col-span-2'],
  ['line1', 'Address', 'address-line1', 'sm:col-span-2'],
  ['city', 'City', 'address-level2', ''],
  ['state', 'State', 'address-level1', ''],
  ['postalCode', 'PIN code (6 digits)', 'postal-code', ''],
];

/** A small form so a customer without a saved address can still check out. */
function AddAddressForm({ onSaved, onCancel }) {
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
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {ADDRESS_FIELDS.map(([field, label, autoComplete, span]) => (
          <Field key={field} label={label} className={span}>
            <Input
              value={form[field]}
              onChange={set(field)}
              autoComplete={autoComplete}
              inputMode={field === 'postalCode' ? 'numeric' : undefined}
              required
            />
          </Field>
        ))}
      </div>
      {save.error && <Alert tone="danger">{save.error.message}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={save.isPending}>
          Save address
        </Button>
        {onCancel && (
          <Button variant="secondary" onClick={onCancel} disabled={save.isPending}>
            Cancel
          </Button>
        )}
      </div>
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

  if (cartQuery.isPending || addressesQuery.isPending) return <PageLoading />;
  if (cartQuery.error || addressesQuery.error) {
    return (
      <Container narrow className="py-12">
        <ErrorState message={(cartQuery.error ?? addressesQuery.error).message} />
      </Container>
    );
  }
  const cart = cartQuery.data;
  const addresses = addressesQuery.data;
  if (cart.items.length === 0) {
    return (
      <Container narrow className="py-12 sm:py-16">
        <EmptyState
          icon="cart"
          title="Your cart is empty"
          description="Add something to your cart before you check out."
          action={<LinkButton to="/search">Browse products</LinkButton>}
        />
      </Container>
    );
  }

  const selected = chosen || addresses.find((a) => a.isDefault)?.id || addresses[0]?.id || '';
  const blocked = cart.hasIssues;
  const showForm = addresses.length === 0 || adding;

  return (
    <Container className="py-8 sm:py-10">
      <PageHeader title="Checkout" back={{ to: '/cart', label: 'Back to cart' }} />
      {blocked && (
        <Alert tone="warning" className="mb-6">
          Some items in your cart need attention.{' '}
          <Link to="/cart" className={linkClasses}>
            Fix your cart
          </Link>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        <Card>
          <CardHeader
            title="Delivery address"
            description={
              showForm ? 'Where should we send your order?' : 'Choose where your order should go.'
            }
          />
          {!showForm && (
            <>
              <fieldset>
                <legend className="sr-only">Delivery address</legend>
                <ul className="space-y-3">
                  {addresses.map((address) => (
                    <li key={address.id}>
                      <label className="flex cursor-pointer gap-3 rounded-lg border border-slate-200 p-4 transition-colors hover:border-slate-300 has-checked:border-brand-600 has-checked:bg-brand-50/50 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-brand-600">
                        <input
                          type="radio"
                          name="address"
                          value={address.id}
                          checked={selected === address.id}
                          onChange={() => setChosen(address.id)}
                          className="mt-1 size-4 accent-brand-600"
                        />
                        <span className="min-w-0 text-sm text-slate-700">
                          <span className="flex flex-wrap items-center gap-2">
                            <strong className="text-slate-900">{address.name}</strong>
                            {address.isDefault && <Badge tone="brand">Default</Badge>}
                          </span>
                          <span className="mt-0.5 block">
                            {address.line1}, {address.city}, {address.state} {address.postalCode}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
              <Button variant="secondary" className="mt-4" onClick={() => setAdding(true)}>
                <Icon name="plus" className="size-4" />
                Add another address
              </Button>
            </>
          )}
          {showForm && (
            <AddAddressForm
              onSaved={(id) => {
                setChosen(id);
                setAdding(false);
              }}
              onCancel={addresses.length > 0 ? () => setAdding(false) : undefined}
            />
          )}
        </Card>

        <Card as="aside" aria-label="Order summary" className="space-y-5 lg:sticky lg:top-24">
          <h2 className="text-base font-semibold text-slate-900">Order summary</h2>
          <ul className="max-h-64 space-y-3 overflow-y-auto pr-1">
            {cart.items.map((line) => (
              <li key={line.productId} className="flex gap-3">
                <div className="size-14 shrink-0 overflow-hidden rounded-md bg-slate-100">
                  {line.imageUrl && (
                    <img src={line.imageUrl} alt="" className="size-full object-cover" />
                  )}
                </div>
                <div className="min-w-0 flex-1 text-sm">
                  <p className="line-clamp-2 font-medium text-slate-900">{line.title}</p>
                  <p className="text-xs text-slate-500">Qty {line.quantity}</p>
                </div>
                {line.status !== 'unavailable' && (
                  <p className="tabular text-sm font-medium text-slate-900">
                    {formatINR(line.lineNetPaise)}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <OrderTotals
            rows={[
              ['Subtotal', formatINR(cart.subtotalPaise)],
              ...(cart.discountPaise > 0
                ? [
                    [
                      `Discount${cart.coupon ? ` (${cart.coupon.code})` : ''}`,
                      `\u2212${formatINR(cart.discountPaise)}`,
                      'success',
                    ],
                  ]
                : []),
              ['Shipping', 'Free'],
            ]}
            total={formatINR(cart.totalPaise)}
          />
          {place.error && <Alert tone="danger">{checkoutErrorMessage(place.error)}</Alert>}
          <Button
            size="lg"
            className="w-full"
            disabled={blocked || !selected}
            loading={place.isPending}
            onClick={() => place.mutate(selected)}
          >
            <Icon name="lock" className="size-4.5" />
            {place.isPending ? 'Placing order…' : 'Place order'}
          </Button>
          <div className="space-y-1.5 text-xs text-slate-500">
            <p className="flex gap-2">
              <Icon name="credit-card" className="size-4 shrink-0" />
              You pay on the next screen, right after your order is placed.
            </p>
            <p className="flex gap-2">
              <Icon name="info" className="size-4 shrink-0" />
              Stock is held for you for 15 minutes once you place the order. Prices and your coupon
              are checked again now.
            </p>
          </div>
        </Card>
      </div>
    </Container>
  );
}
