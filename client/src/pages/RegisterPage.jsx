import { Link, Navigate, useNavigate } from 'react-router-dom';
import { FormError, useSubmit } from '../auth/AuthForm.jsx';
import { useAuth } from '../auth/AuthContext.jsx';

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
    <>
      <h1>{vendor ? 'Sell on Marketplace' : 'Create your account'}</h1>
      <form className="auth-form" onSubmit={onSubmit}>
        <label>
          Name
          <input name="name" autoComplete="name" minLength={2} maxLength={80} required />
        </label>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            maxLength={72}
            required
          />
          <small>10-72 characters, with at least one letter and one number.</small>
        </label>
        <FormError error={error} />
        <button type="submit" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>
      <p>
        Already registered? <Link to="/login">Log in</Link>
      </p>
    </>
  );
}
