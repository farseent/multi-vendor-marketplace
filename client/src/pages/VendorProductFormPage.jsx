import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FormError, useSubmit } from '../auth/AuthForm.jsx';
import ImageUploader from '../components/ImageUploader.jsx';
import { Alert, Button, Card, CardHeader, ErrorState, Field, Input, LinkButton, PageHeader, PageLoading, Select, Textarea } from '../components/ui';
import { apiFetch } from '../lib/api.js';
import { paiseToRupees, rupeesToPaise } from '../lib/money.js';

/** Flattens the category tree into <option>s: "Clothing", "Clothing › Kurtas". */
function categoryOptions(tree) {
  return tree.flatMap((root) => [
    { id: root.id, label: root.name },
    ...root.children.map((child) => ({ id: child.id, label: `${root.name} › ${child.name}` })),
  ]);
}

// Turns "149.9" into paise or throws a message the form can show.
function pricePaiseFrom(text, label, { optional = false } = {}) {
  if (optional && !text.trim()) return null;
  const paise = rupeesToPaise(text);
  if (paise === null) throw new Error(`${label}: enter an amount like 1499 or 1499.50`);
  return paise;
}

function StockForm({ product }) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(false);
  const { error, submitting, onSubmit } = useSubmit(async (form) => {
    setSaved(false);
    const stockQty = Number(form.get('stockQty'));
    await apiFetch(`/vendor/products/${product.id}/stock`, { method: 'PATCH', body: { stockQty } });
    await queryClient.invalidateQueries({ queryKey: ['vendor', 'products'] });
    setSaved(true);
  });
  return (
    <Card>
      <CardHeader title="Stock" description="Stock is updated on its own, separately from the product details." />
      <form className="max-w-xs space-y-4" onSubmit={onSubmit}>
        <Field label="Units in stock">
          <Input name="stockQty" type="number" min="0" step="1" defaultValue={product.stockQty} required />
        </Field>
        <FormError error={error} />
        {saved && <Alert tone="success">Stock updated.</Alert>}
        <Button type="submit" variant="secondary" loading={submitting}>
          Update stock
        </Button>
      </form>
    </Card>
  );
}

function ProductForm({ product, categories }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isEdit = Boolean(product);
  const [images, setImages] = useState(product?.images ?? []);

  const { error, submitting, onSubmit } = useSubmit(async (form) => {
    if (images.length === 0) throw new Error('Add at least one image.');
    const description = form.get('description').trim();
    const fields = {
      title: form.get('title'),
      categoryId: form.get('categoryId'),
      pricePaise: pricePaiseFrom(form.get('price'), 'Price'),
      sku: form.get('sku'),
      images: images.map(({ key, alt }) => ({ key, ...(alt && { alt }) })),
      status: form.get('status'),
    };
    const compareAt = pricePaiseFrom(form.get('compareAt'), 'Compare-at price', { optional: true });

    if (isEdit) {
      await apiFetch(`/vendor/products/${product.id}`, {
        method: 'PATCH',
        body: { ...fields, description: description || null, compareAtPricePaise: compareAt },
      });
    } else {
      await apiFetch('/vendor/products', {
        method: 'POST',
        body: {
          ...fields,
          stockQty: Number(form.get('stockQty')),
          ...(description && { description }),
          ...(compareAt !== null && { compareAtPricePaise: compareAt }),
        },
      });
    }
    await queryClient.invalidateQueries({ queryKey: ['vendor', 'products'] });
    navigate('/vendor/products');
  });

  const statuses = isEdit ? ['draft', 'active', 'archived'] : ['draft', 'active'];
  return (
    <form className="space-y-6" onSubmit={onSubmit}>
      <Card>
        <CardHeader title="Basic information" />
        <div className="space-y-4">
          <Field label="Title">
            <Input name="title" defaultValue={product?.title} minLength={3} maxLength={150} required />
          </Field>
          <Field label="Description">
            <Textarea name="description" defaultValue={product?.description} maxLength={5000} rows={5} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category">
              <Select name="categoryId" defaultValue={product?.categoryId ?? ''} required>
                <option value="" disabled>
                  Choose a category
                </option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Status">
              <Select name="status" defaultValue={product?.status ?? 'draft'}>
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Pricing and inventory" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Price (₹)">
            <Input
              name="price"
              inputMode="decimal"
              defaultValue={product ? paiseToRupees(product.pricePaise) : ''}
              required
            />
          </Field>
          <Field label="Compare-at price (₹, optional)" hint="Must be higher than the price. Shown crossed out.">
            <Input
              name="compareAt"
              inputMode="decimal"
              defaultValue={product?.compareAtPricePaise ? paiseToRupees(product.compareAtPricePaise) : ''}
            />
          </Field>
          <Field label="SKU">
            <Input name="sku" defaultValue={product?.sku} maxLength={64} required />
          </Field>
          {!isEdit && (
            <Field label="Units in stock">
              <Input name="stockQty" type="number" min="0" step="1" defaultValue="0" required />
            </Field>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Images" />
        <ImageUploader images={images} onChange={setImages} />
      </Card>

      <FormError error={error} />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" size="lg" loading={submitting}>
          {isEdit ? 'Save changes' : 'Create product'}
        </Button>
        <LinkButton to="/vendor/products" variant="secondary" size="lg">
          Cancel
        </LinkButton>
      </div>
    </form>
  );
}

export default function VendorProductFormPage() {
  const { productId } = useParams();
  const isEdit = Boolean(productId);

  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: async () => categoryOptions((await apiFetch('/categories')).data),
  });
  const product = useQuery({
    queryKey: ['vendor', 'product', productId],
    queryFn: async () => (await apiFetch(`/vendor/products/${productId}`)).data,
    enabled: isEdit,
    retry: false,
  });

  if (categories.isPending || (isEdit && product.isPending)) return <PageLoading />;
  if (categories.error) return <Alert tone="danger">{categories.error.message}</Alert>;
  if (product.error) {
    return (
      <ErrorState
        title={product.error.status === 404 ? 'Product not found' : 'We could not load this product'}
        message={product.error.status === 404 ? undefined : product.error.message}
        action={<LinkButton to="/vendor/products">Back to products</LinkButton>}
      />
    );
  }
  if (!isEdit && categories.data.length === 0) {
    return <Alert tone="warning">No categories exist yet. Ask the marketplace admin to create one.</Alert>;
  }

  return (
    <>
      <PageHeader
        title={isEdit ? 'Edit product' : 'New product'}
        back={{ to: '/vendor/products', label: 'Back to products' }}
      />
      <div className="space-y-6">
        <ProductForm
          key={product.data?.id ?? 'new'}
          product={product.data}
          categories={categories.data}
        />
        {isEdit && <StockForm key={`stock-${product.data.id}`} product={product.data} />}
      </div>
    </>
  );
}