import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FormError, useSubmit } from '../auth/AuthForm.jsx';
import { apiFetch } from '../lib/api.js';
import './catalog.css';

const STATUS_HELP = {
  pending: 'Waiting for admin approval. You can prepare draft products, but not publish them yet.',
  approved: 'Your shop is approved. Active products are visible to customers.',
  rejected: 'Your shop was not approved. Contact the marketplace admin.',
  suspended: 'Your shop is suspended. Your products are hidden from customers.',
};

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

  if (isPending) return <p>Loading…</p>;
  if (error && error.status !== 404) return <p role="alert">{error.message}</p>;

  return (
    <>
      <h1>{shop ? 'Your shop' : 'Create your shop'}</h1>
      {shop && (
        <p className="notice">
          Status: <span className={`badge ${shop.status}`}>{shop.status}</span>{' '}
          {STATUS_HELP[shop.status]}
        </p>
      )}
      <form className="auth-form" onSubmit={onSubmit} key={shop?.id ?? 'new'}>
        <label>
          Shop name
          <input
            name="shopName"
            defaultValue={shop?.shopName}
            minLength={3}
            maxLength={60}
            required
          />
        </label>
        <label>
          Description
          <textarea name="description" defaultValue={shop?.description} maxLength={1000} rows={4} />
        </label>
        <FormError error={formError} />
        <button type="submit" disabled={submitting}>
          {shop ? 'Save changes' : 'Create shop'}
        </button>
      </form>
      {shop && <p>Public page: /shops/{shop.shopSlug} (visible once approved)</p>}
    </>
  );
}
