import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, Card, EmptyState, Field, PageHeader, PageLoading, Pagination, Select, Stars, StatusBadge, Table, TBody, Td, Th, THead } from '../components/ui';
import { adminErrorMessage, adminKey, adminList, adminSend } from '../lib/admin.js';
import { useAdminAction } from './hooks.js';

/** Moderation: every review, newest first. Hiding one removes it from the product page and its rating. */
export default function AdminReviewsPage() {
  const [filters, setFilters] = useState({ status: '', page: 1 });
  const { data, error, isPending } = useQuery({
    queryKey: adminKey('reviews', filters),
    queryFn: () => adminList('reviews', filters),
    placeholderData: keepPreviousData,
  });
  const setStatus = useAdminAction(({ id, status }) =>
    adminSend(`reviews/${id}/status`, 'PATCH', { status }),
  );
  const problem = error ?? setStatus.error;

  return (
    <>
      <PageHeader title="Reviews" description="Hiding a review removes it from the product page and from its rating." />
      <Card className="mb-6">
        <Field label="Status" className="max-w-xs">
          <Select value={filters.status} onChange={(e) => setFilters({ status: e.target.value, page: 1 })}>
            <option value="">All</option>
            <option value="published">Published</option>
            <option value="hidden">Hidden</option>
          </Select>
        </Field>
      </Card>
      {problem && <Alert tone="danger" className="mb-4">{adminErrorMessage(problem)}</Alert>}
      {isPending && <PageLoading />}
      {data?.items.length === 0 && <EmptyState icon="message" title="No reviews match" />}
      {data?.items.length > 0 && (
        <Table label="Reviews">
          <THead>
            <Th>Product</Th>
            <Th>Rating</Th>
            <Th>Review</Th>
            <Th>Customer</Th>
            <Th>Status</Th>
            <Th>Action</Th>
          </THead>
          <TBody>
            {data.items.map((r) => (
              <tr key={r.id}>
                <Td header className="min-w-40">{r.product.title ?? r.product.id}</Td>
                <Td className="whitespace-nowrap">
                  <Stars rating={r.rating} />
                  <span className="sr-only">{r.rating} / 5</span>
                </Td>
                <Td className="min-w-64 max-w-md">
                  {r.title && <strong className="text-slate-900">{r.title}. </strong>}
                  {r.body}
                </Td>
                <Td>{r.customer?.email}</Td>
                <Td>
                  <StatusBadge status={r.status} />
                </Td>
                <Td>
                  <Button
                    variant={r.status === 'hidden' ? 'secondary' : 'danger-outline'}
                    size="sm"
                    disabled={setStatus.isPending}
                    onClick={() =>
                      setStatus.mutate({ id: r.id, status: r.status === 'hidden' ? 'published' : 'hidden' })
                    }
                  >
                    {r.status === 'hidden' ? 'Publish' : 'Hide'}
                  </Button>
                </Td>
              </tr>
            ))}
          </TBody>
        </Table>
      )}
      <Pagination meta={data?.meta} onPage={(page) => setFilters({ ...filters, page })} showTotal />
    </>
  );
}