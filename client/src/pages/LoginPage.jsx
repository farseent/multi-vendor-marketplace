import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { FormError, useSubmit } from '../auth/AuthForm.jsx';
import { useAuth } from '../auth/AuthContext.jsx';

// Only follow same-site paths ("/orders"), never "//evil.com" or full URLs.
const safePath = (value) =>
  typeof value === 'string' && /^\/(?!\/)/.test(value) ? value : '/account';

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
    <>
      <h1>Log in</h1>
      <form className="auth-form" onSubmit={onSubmit}>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <FormError error={error} />
        <button type="submit" disabled={submitting}>
          {submitting ? 'Logging in…' : 'Log in'}
        </button>
      </form>
      <p>
        New here? <Link to="/register">Create an account</Link> or{' '}
        <Link to="/register-vendor">sell on Marketplace</Link>.
      </p>
    </>
  );
}
