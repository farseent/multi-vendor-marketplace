import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Input,
  Modal,
  PageHeader,
  PageLoading,
  Select,
  StatusBadge,
  Table,
  TBody,
  Td,
  Th,
  THead,
} from '../components/ui';
import { adminErrorMessage, adminKey, adminList, adminSend } from '../lib/admin.js';
import {
  buildCategoryTree,
  categoryCounts,
  categoryErrors,
  categoryRequest,
  categoryRows,
  categoryToForm,
  commissionLabel,
  emptyCategoryForm,
  hasChildren,
  parentChoices,
} from '../lib/categories.js';
import { useAdminAction } from './hooks.js';

// The public category tree (vendor product form, storefront) is cached under this key.
const PUBLIC_CATEGORIES_KEY = ['categories'];

/** A write to /admin/categories. Refreshes the admin list and the public tree. */
function useCategoryAction(action) {
  const queryClient = useQueryClient();
  return useAdminAction(async (variables) => {
    const result = await action(variables);
    await queryClient.invalidateQueries({ queryKey: PUBLIC_CATEGORIES_KEY });
    return result;
  });
}

/** Create or edit one category. Rendered inside a Modal, so its state starts fresh each time. */
function CategoryForm({ category, parentId = '', categories, onDone, onCancel, onBusy }) {
  const editing = Boolean(category);
  const [form, setForm] = useState(() =>
    editing ? categoryToForm(category) : emptyCategoryForm(parentId),
  );
  const [errors, setErrors] = useState({});
  const [notice, setNotice] = useState(null); // { tone, text }
  const save = useCategoryAction(({ body }) =>
    editing
      ? adminSend(`categories/${category.id}`, 'PATCH', body)
      : adminSend('categories', 'POST', body),
  );

  // Tells the page a request is running (it blocks Escape and backdrop clicks); the cleanup makes
  // sure the page is never left "busy" when this form closes.
  useEffect(() => {
    onBusy?.(save.isPending);
    return () => onBusy?.(false);
  }, [save.isPending, onBusy]);

  const choices = parentChoices(categories, category?.id);
  const locked = editing && hasChildren(categories, category.id);
  const field = (name) => ({
    value: form[name],
    onChange: (e) => setForm({ ...form, [name]: e.target.value }),
    'aria-invalid': Boolean(errors[name]),
  });

  function submit(e) {
    e.preventDefault();
    setNotice(null);
    const result = categoryRequest(form, { categories, original: category });
    setErrors(result.ok ? {} : result.errors);
    if (!result.ok) {
      if (result.unchanged) setNotice({ tone: 'info', text: 'No changes to save.' });
      return;
    }
    save.mutate(
      { body: result.body },
      {
        onSuccess: onDone,
        onError: (error) => {
          const { fieldErrors, message } = categoryErrors(error, {
            slugGiven: Boolean(result.body.slug),
          });
          setErrors(fieldErrors);
          if (message) setNotice({ tone: 'danger', text: message });
        },
      },
    );
  }

  return (
    <form className="grid gap-4 sm:grid-cols-2" noValidate onSubmit={submit}>
      <Field label="Name" error={errors.name} className="sm:col-span-2">
        <Input {...field('name')} maxLength={60} required autoFocus={!editing} autoComplete="off" />
      </Field>
      <Field
        label="Slug"
        error={errors.slug}
        hint={
          editing
            ? 'Fixed after creation, because changing it could break existing links.'
            : 'Optional. Leave empty to create it from the name. Lowercase letters, digits and hyphens.'
        }
      >
        <Input
          {...field('slug')}
          maxLength={80}
          disabled={editing}
          autoComplete="off"
          className="font-mono"
        />
      </Field>
      <Field
        label="Parent category"
        error={errors.parentId}
        hint={
          locked
            ? 'This category has sub-categories, so it has to stay top-level.'
            : 'Categories go two levels deep. Only top-level categories can be parents.'
        }
      >
        <Select {...field('parentId')} disabled={locked}>
          <option value="">None (top-level category)</option>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Default commission (%)"
        error={errors.defaultCommission}
        hint="Optional, 0 to 50. Leave empty to use the platform default rate."
      >
        <Input {...field('defaultCommission')} inputMode="decimal" placeholder="Platform default" />
      </Field>
      <Field label="Display order" error={errors.sortOrder} hint="Lower numbers are listed first.">
        <Input {...field('sortOrder')} inputMode="numeric" maxLength={4} />
      </Field>
      <div className="sm:col-span-2">
        <Checkbox
          label="Active: shown to customers and available to vendors"
          checked={form.isActive}
          onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
        />
      </div>
      {notice && (
        <Alert tone={notice.tone} className="sm:col-span-2">
          {notice.text}
        </Alert>
      )}
      <div className="flex flex-col-reverse gap-2 sm:col-span-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={onCancel} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="submit" loading={save.isPending}>
          {editing ? 'Save changes' : 'Create category'}
        </Button>
      </div>
    </form>
  );
}

function StatusCell({ category, hiddenByParent }) {
  if (!category.isActive) return <Badge>Inactive</Badge>;
  if (hiddenByParent) return <Badge tone="warning">Hidden: parent inactive</Badge>;
  return <StatusBadge status="active" />;
}

/** The category hierarchy: create, edit, reorder, nest and switch categories on or off. */
export default function AdminCategoriesPage() {
  const [dialog, setDialog] = useState(null); // { category? , parentId? }; null = closed
  const [busy, setBusy] = useState(false);
  const [deactivating, setDeactivating] = useState(null);
  const { data, error, isPending, refetch } = useQuery({
    queryKey: adminKey('categories'),
    queryFn: () => adminList('categories'),
  });
  const toggle = useCategoryAction(({ id, isActive }) =>
    adminSend(`categories/${id}`, 'PATCH', { isActive }),
  );

  const categories = data?.items;
  const rows = useMemo(() => categoryRows(buildCategoryTree(categories)), [categories]);
  const names = useMemo(() => new Map((categories ?? []).map((c) => [c.id, c.name])), [categories]);
  const counts = categoryCounts(categories);
  const closeDialog = () => setDialog(null);

  const dialogTitle = dialog?.category
    ? `Edit ${dialog.category.name}`
    : dialog?.parentId
      ? `New sub-category of ${names.get(dialog.parentId) ?? 'category'}`
      : 'New category';

  return (
    <>
      <PageHeader
        title="Categories"
        description="Organise the catalog into top-level categories and their sub-categories. Vendors choose from these when they list a product."
        actions={
          categories && (
            <Button onClick={() => setDialog({})}>
              <Icon name="plus" className="size-4" /> New category
            </Button>
          )
        }
      />
      {toggle.error && (
        <Alert tone="danger" className="mb-4">
          {adminErrorMessage(toggle.error)}
        </Alert>
      )}
      {isPending && <PageLoading />}
      {error && !data && (
        <ErrorState
          message={adminErrorMessage(error)}
          action={<Button onClick={() => refetch()}>Try again</Button>}
        />
      )}
      {categories?.length === 0 && (
        <EmptyState
          icon="grid"
          title="No categories yet"
          description="Vendors cannot list a product until at least one category exists."
          action={<Button onClick={() => setDialog({})}>Create the first category</Button>}
        />
      )}
      {categories?.length > 0 && (
        <>
          <p className="mb-3 text-sm text-slate-600" aria-live="polite">
            {counts.topLevel} top-level · {counts.subCategories} sub-categories · {counts.inactive}{' '}
            inactive
          </p>
          <Table label="Category hierarchy">
            <THead>
              <Th>Category</Th>
              <Th>Status</Th>
              <Th>Commission</Th>
              <Th num>Order</Th>
              <Th>Actions</Th>
            </THead>
            <TBody>
              {rows.map(({ category: c, depth, hiddenByParent }) => (
                <tr key={c.id} className={depth ? 'bg-slate-50/60' : undefined}>
                  <Td header>
                    <div className={depth ? 'flex items-start gap-2 pl-4 sm:pl-8' : undefined}>
                      {depth > 0 && (
                        <span aria-hidden="true" className="select-none text-slate-400">
                          └
                        </span>
                      )}
                      <div className="min-w-0">
                        <span className={depth ? undefined : 'font-semibold'}>{c.name}</span>
                        {depth > 0 && (
                          <span className="sr-only">
                            {' '}
                            (sub-category of {names.get(c.parentId)})
                          </span>
                        )}
                        <span className="block font-mono text-xs font-normal text-slate-500">
                          {c.slug}
                        </span>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <StatusCell category={c} hiddenByParent={hiddenByParent} />
                  </Td>
                  <Td className="whitespace-nowrap">{commissionLabel(c)}</Td>
                  <Td num>{c.sortOrder}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setDialog({ category: c })}
                        aria-label={`Edit ${c.name}`}
                      >
                        Edit
                      </Button>
                      {depth === 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDialog({ parentId: c.id })}
                          aria-label={`Add a sub-category to ${c.name}`}
                        >
                          Add sub-category
                        </Button>
                      )}
                      {c.isActive ? (
                        <Button
                          variant="danger-outline"
                          size="sm"
                          disabled={toggle.isPending}
                          onClick={() => setDeactivating(c)}
                          aria-label={`Deactivate ${c.name}`}
                        >
                          Deactivate
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={toggle.isPending}
                          onClick={() => toggle.mutate({ id: c.id, isActive: true })}
                          aria-label={`Activate ${c.name}`}
                        >
                          Activate
                        </Button>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </TBody>
          </Table>
        </>
      )}

      <Modal
        open={Boolean(dialog)}
        onClose={closeDialog}
        title={dialogTitle}
        description={
          dialog?.category
            ? undefined
            : 'Pick a parent to create a sub-category, or leave it empty for a top-level category.'
        }
        dismissible={!busy}
        size="lg"
      >
        {dialog && (
          <CategoryForm
            category={dialog.category}
            parentId={dialog.parentId}
            categories={categories ?? []}
            onDone={closeDialog}
            onCancel={closeDialog}
            onBusy={setBusy}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(deactivating)}
        title={deactivating ? `Deactivate ${deactivating.name}?` : ''}
        message={
          deactivating && hasChildren(categories, deactivating.id)
            ? 'It and its sub-categories disappear from the storefront and the vendor product form until it is active again. Existing products are not changed.'
            : 'Vendors cannot pick it for new products and it disappears from the storefront category list until it is active again. Existing products are not changed.'
        }
        confirmLabel="Deactivate"
        pending={toggle.isPending}
        onConfirm={() =>
          toggle.mutate(
            { id: deactivating.id, isActive: false },
            { onSettled: () => setDeactivating(null) },
          )
        }
        onCancel={() => setDeactivating(null)}
      />
    </>
  );
}