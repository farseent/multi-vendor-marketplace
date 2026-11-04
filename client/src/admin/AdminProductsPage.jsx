import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  Icon,
  Input,
  PageHeader,
  PageLoading,
  Pagination,
  Select,
  StatusBadge,
  Table,
  TBody,
  Td,
  Th,
  THead,
} from '../components/ui';
import { adminErrorMessage, adminKey, adminList, adminSend } from '../lib/admin.js';
import { formatINR } from '../lib/money.js';
import { useAdminAction } from './hooks.js';

const STATUSES = ['', 'active', 'draft', 'archived', 'suspended'];

/** Every product of every shop. An admin can suspend one, or send a suspended one back to draft. */
export default function AdminProductsPage() {
  const [filters, setFilters] = useState({ status: '', q: '', page: 1 });
  const [text, setText] = useState('');
  const [toSuspend, setToSuspend] = useState(null);
  const { data, error, isPending } = useQuery({
    queryKey: adminKey('products', filters),
    queryFn: () => adminList('products', filters),
    placeholderData: keepPreviousData,
  });
  const setStatus = useAdminAction(({ id, status }) =>
    adminSend(`products/${id}/status`, 'PATCH', { status }),
  );
  const problem = error ?? setStatus.error;

  return (
    <>
      <PageHeader
        title="Products"
        description="Every product of every shop. Suspend one to remove it from the shop and search."
      />
      <Card className="mb-6">
        <form
          className="grid gap-4 sm:grid-cols-[14rem_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters({ ...filters, q: text.trim(), page: 1 });
          }}
        >
          <Field label="Status">
            <Select
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value, page: 1 })}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s || 'All'}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Title contains">
            <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={100} />
          </Field>
          <Button type="submit">
            <Icon name="filter" className="size-4" />
            Filter
          </Button>
        </form>
      </Card>
      {problem && (
        <Alert tone="danger" className="mb-4">
          {adminErrorMessage(problem)}
        </Alert>
      )}
      {isPending && <PageLoading />}
      {data?.items.length === 0 && <EmptyState icon="package" title="No products match" />}
      {data?.items.length > 0 && (
        <Table label="Products">
          <THead>
            <Th>Product</Th>
            <Th>Shop</Th>
            <Th>Status</Th>
            <Th num>Price</Th>
            <Th num>Stock</Th>
            <Th>Action</Th>
          </THead>
          <TBody>
            {data.items.map((p) => (
              <tr key={p.id}>
                <Td header className="min-w-48">
                  {p.title}
                </Td>
                <Td>{p.shop?.name}</Td>
                <Td>
                  <StatusBadge status={p.status} />
                </Td>
                <Td num>{formatINR(p.pricePaise)}</Td>
                <Td num>{p.stockQty}</Td>
                <Td>
                  {p.status === 'suspended' ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={setStatus.isPending}
                      title="Back to draft: the vendor publishes it again"
                      onClick={() => setStatus.mutate({ id: p.id, status: 'draft' })}
                    >
                      Restore to draft
                    </Button>
                  ) : (
                    <Button
                      variant="danger-outline"
                      size="sm"
                      disabled={setStatus.isPending}
                      onClick={() => setToSuspend(p)}
                    >
                      Suspend
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </TBody>
        </Table>
      )}
      <Pagination meta={data?.meta} onPage={(page) => setFilters({ ...filters, page })} showTotal />
      <ConfirmDialog
        open={Boolean(toSuspend)}
        title="Suspend this product?"
        message={
          toSuspend ? `\u201c${toSuspend.title}\u201d disappears from the shop and search.` : ''
        }
        confirmLabel="Suspend"
        pending={setStatus.isPending}
        onConfirm={() =>
          setStatus.mutate(
            { id: toSuspend.id, status: 'suspended' },
            { onSettled: () => setToSuspend(null) },
          )
        }
        onCancel={() => setToSuspend(null)}
      />
    </>
  );
}
