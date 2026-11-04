import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { FormError, useSubmit } from '../auth/AuthForm.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import AuthShell from '../components/AuthShell.jsx';
import { Button, Field, Input } from '../components/ui';
import { linkClasses } from '../components/ui/classes.js';

// Only follow same-site paths ("/orders"), never "//evil.com" or full URLs.
const safePath = (value) =>
  typeof value === 'string' && /^\/(?!\/)/.test(value) ? value : '/account';

const POINTS = [
  ['cart', 'One cart, many sellers', 'Buy from several shops and pay once at checkout.'],
  ['truck', 'Track every order', 'See each seller\u2019s shipment and its tracking details.'],
  ['shield', 'Reviews you can trust', 'Only customers who received a product can review it.'],
];

export default function LoginPage() {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const target = safePath(useLocation().state?.from);

  const { error, submitting, onSubmit } = useSubmit(async (form) => {
    await login({ email: form.get('email'), password: form.get('password') });
    navigate(target, { replace: true });
  });

  if (status === 'authenticated') return <Navigate to={target} replace />;

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Log in to see your cart, orders and account."
      points={POINTS}
      footer={
        <p>
          New here?{' '}
          <Link to="/register" className={linkClasses}>
            Create an account
          </Link>{' '}
          or{' '}
          <Link to="/register-vendor" className={linkClasses}>
            sell on Marketplace
          </Link>
          .
        </p>
      }
    >
      <form className="space-y-4" onSubmit={onSubmit}>
        <Field label="Email">
          <Input name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Password">
          <Input name="password" type="password" autoComplete="current-password" required />
        </Field>
        <FormError error={error} />
        <Button type="submit" size="lg" className="w-full" loading={submitting}>
          {submitting ? 'Logging in…' : 'Log in'}
        </Button>
      </form>
    </AuthShell>
  );
}