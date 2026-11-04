import { useState } from 'react';
import { FormError, useSubmit } from '../auth/AuthForm.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Container,
  Field,
  Icon,
  Input,
  LinkButton,
  PageHeader,
} from '../components/ui';
import { apiFetch } from '../lib/api.js';

const DASHBOARDS = {
  vendor: { to: '/vendor/shop', label: 'Open seller dashboard' },
  admin: { to: '/admin', label: 'Open admin console' },
};

export default function AccountPage() {
  const { user, logout } = useAuth();
  const [changed, setChanged] = useState(false);
  const dashboard = DASHBOARDS[user.role];

  const { error, submitting, onSubmit } = useSubmit(async (form) => {
    setChanged(false);
    await apiFetch('/auth/change-password', {
      method: 'POST',
      body: { currentPassword: form.get('currentPassword'), newPassword: form.get('newPassword') },
    });
    setChanged(true);
  });

  return (
    <Container narrow className="py-8 sm:py-10">
      <PageHeader title="Your account" />
      <div className="space-y-6">
        <Card>
          <div className="flex flex-wrap items-center gap-4">
            <span
              aria-hidden="true"
              className="grid size-14 place-items-center rounded-full bg-brand-600 text-xl font-semibold uppercase text-white"
            >
              {user.name?.[0]}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-lg font-semibold text-slate-900">{user.name}</p>
              <p className="truncate text-sm text-slate-600">{user.email}</p>
              <Badge tone="brand" className="mt-1.5">
                {user.role}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              {dashboard && (
                <LinkButton to={dashboard.to} variant="secondary">
                  {dashboard.label}
                </LinkButton>
              )}
              <Button variant="secondary" onClick={logout}>
                <Icon name="log-out" className="size-4" />
                Log out
              </Button>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Change password"
            description="Your other devices are logged out when you change it."
          />
          <form className="max-w-md space-y-4" onSubmit={onSubmit}>
            <Field label="Current password">
              <Input
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
            <Field
              label="New password"
              hint="10-72 characters, with at least one letter and one number."
            >
              <Input
                name="newPassword"
                type="password"
                autoComplete="new-password"
                minLength={10}
                maxLength={72}
                required
              />
            </Field>
            <FormError error={error} />
            {changed && (
              <Alert tone="success">Password changed. Your other devices were logged out.</Alert>
            )}
            <Button type="submit" loading={submitting}>
              Change password
            </Button>
          </form>
        </Card>
      </div>
    </Container>
  );
}
