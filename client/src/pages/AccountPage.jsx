import { useState } from 'react';
import { FormError, useSubmit } from '../auth/AuthForm.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import { apiFetch } from '../lib/api.js';

export default function AccountPage() {
  const { user, logout } = useAuth();
  const [changed, setChanged] = useState(false);

  const { error, submitting, onSubmit } = useSubmit(async (form) => {
    setChanged(false);
    await apiFetch('/auth/change-password', {
      method: 'POST',
      body: { currentPassword: form.get('currentPassword'), newPassword: form.get('newPassword') },
    });
    setChanged(true);
  });

  return (
    <>
      <h1>Your account</h1>
      <p>
        {user.name} ({user.email}) · role: {user.role}
      </p>
      <p>
        <button type="button" onClick={logout}>
          Log out
        </button>
      </p>

      <h2>Change password</h2>
      <form className="auth-form" onSubmit={onSubmit}>
        <label>
          Current password
          <input name="currentPassword" type="password" autoComplete="current-password" required />
        </label>
        <label>
          New password
          <input
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={10}
            maxLength={72}
            required
          />
        </label>
        <FormError error={error} />
        {changed && <p role="status">Password changed. Your other devices were logged out.</p>}
        <button type="submit" disabled={submitting}>
          Change password
        </button>
      </form>
    </>
  );
}
