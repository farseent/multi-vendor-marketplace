import { Link, Navigate, useNavigate } from 'react-router-dom';
import { FormError, useSubmit } from '../auth/AuthForm.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import AuthShell from '../components/AuthShell.jsx';
import { Button, Field, Input } from '../components/ui';
import { linkClasses } from '../components/ui/classes.js';

const CUSTOMER_POINTS = [
  ['cart', 'One cart, many sellers', 'Buy from several shops and pay once at checkout.'],
  ['package', 'Free shipping', 'Shipping is free on every order.'],
  [
    'shield',
    'Refunds when a seller cancels',
    'Cancel an unshipped part of your order and get your money back.',
  ],
];

const VENDOR_POINTS = [
  ['store', 'Open your shop', 'Create a shop profile and start preparing products right away.'],
  ['package', 'Manage products and stock', 'Add listings with photos, prices and stock levels.'],
  [
    'wallet',
    'Get paid after delivery',
    'Payouts are released once an order\u2019s 7-day return window ends.',
  ],
];

/** One page for both sign-ups; `vendor` switches the endpoint (shop profile comes in Phase 2). */
export default function RegisterPage({ vendor = false }) {
  const { status, register } = useAuth();
  const navigate = useNavigate();

  const { error, submitting, onSubmit } = useSubmit(async (form) => {
    await register(
      { name: form.get('name'), email: form.get('email'), password: form.get('password') },
      { vendor },
    );
    navigate('/account', { replace: true });
  });

  if (status === 'authenticated') return <Navigate to="/account" replace />;

  return (
    <AuthShell
      title={vendor ? 'Sell on Marketplace' : 'Create your account'}
      subtitle={
        vendor
          ? 'Create a seller account. An admin approves your shop before products go live.'
          : 'It takes less than a minute.'
      }
      points={vendor ? VENDOR_POINTS : CUSTOMER_POINTS}
      footer={
        <p>
          Already registered?{' '}
          <Link to="/login" className={linkClasses}>
            Log in
          </Link>
        </p>
      }
    >
      <form className="space-y-4" onSubmit={onSubmit}>
        <Field label="Name">
          <Input name="name" autoComplete="name" minLength={2} maxLength={80} required />
        </Field>
        <Field label="Email">
          <Input name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Password" hint="10-72 characters, with at least one letter and one number.">
          <Input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            maxLength={72}
            required
          />
        </Field>
        <FormError error={error} />
        <Button type="submit" size="lg" className="w-full" loading={submitting}>
          {submitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </AuthShell>
  );
}
