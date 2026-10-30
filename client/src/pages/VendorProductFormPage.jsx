import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { FormError, useSubmit } from '../auth/AuthForm.jsx';
import ImageUploader from '../components/ImageUploader.jsx';
import { apiFetch } from '../lib/api.js';
import { paiseToRupees, rupeesToPaise } from '../lib/money.js';
import './catalog.css';

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
    <form className="auth-form" onSubmit={onSubmit}>
      <h2>Stock</h2>
      <label>
        Units in stock
        <input
          name="stockQty"
          type="number"
          min="0"
          step="1"
          defaultValue={product.stockQty}
          required
        />
      </label>
      <FormError error={error} />
      {saved && <p role="status">Stock updated.</p>}
      <button type="submit" disabled={submitting}>
        Update stock
      </button>
    </form>
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
    <form className="auth-form" onSubmit={onSubmit}>
      <label>
        Title
        <input name="title" defaultValue={product?.title} minLength={3} maxLength={150} required />
      </label>
      <label>
        Description
        <textarea
          name="description"
          defaultValue={product?.description}
          maxLength={5000}
          rows={5}
        />
      </label>
      <label>
        Category
        <select name="categoryId" defaultValue={product?.categoryId ?? ''} required>
          <option value="" disabled>
            Choose a category
          </option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Price (₹)
        <input
          name="price"
          inputMode="decimal"
          defaultValue={product ? paiseToRupees(product.pricePaise) : ''}
          required
        />
      </label>
      <label>
        Compare-at price (₹, optional, must be higher than the price)
        <input
          name="compareAt"
          inputMode="decimal"
          defaultValue={
            product?.compareAtPricePaise ? paiseToRupees(product.compareAtPricePaise) : ''
          }
        />
      </label>
      <label>
        SKU
        <input name="sku" defaultValue={product?.sku} maxLength={64} required />
      </label>
      {!isEdit && (
        <label>
          Units in stock
          <input name="stockQty" type="number" min="0" step="1" defaultValue="0" required />
        </label>
      )}
      <label>
        Status
        <select name="status" defaultValue={product?.status ?? 'draft'}>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <ImageUploader images={images} onChange={setImages} />
      <FormError error={error} />
      <button type="submit" disabled={submitting}>
        {isEdit ? 'Save changes' : 'Create product'}
      </button>
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

  if (categories.isPending || (isEdit && product.isPending)) return <p>Loading…</p>;
  if (categories.error) return <p role="alert">{categories.error.message}</p>;
  if (product.error) {
    return (
      <p role="alert">
        {product.error.status === 404 ? 'Product not found.' : product.error.message}{' '}
        <Link to="/vendor/products">Back to products</Link>
      </p>
    );
  }
  if (!isEdit && categories.data.length === 0) {
    return <p role="alert">No categories exist yet. Ask the marketplace admin to create one.</p>;
  }

  return (
    <>
      <h1>{isEdit ? 'Edit product' : 'New product'}</h1>
      <p>
        <Link to="/vendor/products">← Back to products</Link>
      </p>
      <ProductForm
        key={product.data?.id ?? 'new'}
        product={product.data}
        categories={categories.data}
      />
      {isEdit && <StockForm key={`stock-${product.data.id}`} product={product.data} />}
    </>
  );
}
