import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FormError, useSubmit } from '../auth/AuthForm.jsx';
import { Alert, Button, Card, Field, Input, PageHeader, PageLoading, StatusBadge, Textarea } from '../components/ui';
import { apiFetch } from '../lib/api.js';

const STATUS_HELP = {
  pending: 'Waiting for admin approval. You can prepare draft products, but not publish them yet.',
  approved: 'Your shop is approved. Active products are visible to customers.',
  rejected: 'Your shop was not approved. Contact the marketplace admin.',
  suspended: 'Your shop is suspended. Your products are hidden from customers.',
};
const STATUS_TONE = { pending: 'warning', approved: 'success', rejected: 'danger', suspended: 'danger' };

export const profileQueryKey = ['vendor', 'profile'];

export default function VendorShopPage() {
  const queryClient = useQueryClient();
  const {
    data: shop,
    error,
    isPending,
  } = useQuery({
    queryKey: profileQueryKey,
    queryFn: async () => (await apiFetch('/vendor/profile')).data,
    retry: false, // 404 just means "no shop yet", which is a normal state
  });

  const {
    error: formError,
    submitting,
    onSubmit,
  } = useSubmit(async (form) => {
    const shopName = form.get('shopName');
    const description = form.get('description').trim();
    const saved = shop
      ? await apiFetch('/vendor/profile', {
          method: 'PATCH',
          body: { shopName, description: description || null },
        })
      : await apiFetch('/vendor/profile', {
          method: 'POST',
          body: { shopName, ...(description && { description }) },
        });
    queryClient.setQueryData(profileQueryKey, saved.data);
  });

  if (isPending) return <PageLoading />;
  if (error && error.status !== 404) return <Alert tone="danger">{error.message}</Alert>;

  return (
    <>
      <PageHeader
        title={shop ? 'Your shop' : 'Create your shop'}
        description={shop ? undefined : 'Set up your shop profile so you can start adding products.'}
      />
      <div className="space-y-6">
        {shop && (
          <Alert tone={STATUS_TONE[shop.status] ?? 'info'}>
            <span className="flex flex-wrap items-center gap-2">
              Status: <StatusBadge status={shop.status} /> {STATUS_HELP[shop.status]}
            </span>
          </Alert>
        )}
        <Card>
          <form className="max-w-xl space-y-5" onSubmit={onSubmit} key={shop?.id ?? 'new'}>
            <Field label="Shop name">
              <Input name="shopName" defaultValue={shop?.shopName} minLength={3} maxLength={60} required />
            </Field>
            <Field label="Description" hint="Up to 1000 characters.">
              <Textarea name="description" defaultValue={shop?.description} maxLength={1000} rows={4} />
            </Field>
            <FormError error={formError} />
            <Button type="submit" loading={submitting}>
              {shop ? 'Save changes' : 'Create shop'}
            </Button>
          </form>
        </Card>
        {shop && (
          <p className="text-sm text-slate-500">
            Public page: <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">/shops/{shop.shopSlug}</code>{' '}
            (visible once approved)
          </p>
        )}
      </div>
    </>
  );
}