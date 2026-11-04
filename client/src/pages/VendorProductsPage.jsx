import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Icon, LinkButton, PageHeader, PageLoading, Pagination, Select, StatusBadge, Table, TBody, Td, Th, THead } from '../components/ui';
import { apiFetch } from '../lib/api.js';
import { formatINR } from '../lib/money.js';

const LIMIT = 20;
const STATUSES = ['', 'draft', 'active', 'archived', 'suspended'];

function Thumb({ product }) {
  const url = product.images?.[0]?.url;
  return (
    <div className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg border border-slate-200 bg-slate-100 text-slate-300">
      {url ? <img src={url} alt="" className="size-full object-cover" /> : <Icon name="image" className="size-5" />}
    </div>
  );
}

export default function VendorProductsPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [toArchive, setToArchive] = useState(null);

  const { data, error, isPending } = useQuery({
    queryKey: ['vendor', 'products', { page, status }],
    queryFn: async () => {
      const query = new URLSearchParams({ page, limit: LIMIT, ...(status && { status }) });
      return apiFetch(`/vendor/products?${query}`);
    },
    retry: false,
  });

  const archive = useMutation({
    mutationFn: (id) => apiFetch(`/vendor/products/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['vendor', 'products'] }),
    onSettled: () => setToArchive(null),
  });

  if (error?.code === 'FORBIDDEN') {
    return (
      <Alert tone="warning">
        Create your{' '}
        <Link to="/vendor/shop" className="font-medium underline">
          shop profile
        </Link>{' '}
        first.
      </Alert>
    );
  }

  const products = data?.data ?? [];
  const meta = data?.meta;
  const canArchive = (p) => p.status !== 'archived' && p.status !== 'suspended';

  return (
    <>
      <PageHeader
        title="Your products"
        description="Everything you sell, with price, stock and status."
        actions={
          <LinkButton to="/vendor/products/new" icon="plus">
            Add product
          </LinkButton>
        }
      />
      <Card className="mb-5">
        <Field label="Status" className="max-w-xs">
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s || 'all'}
              </option>
            ))}
          </Select>
        </Field>
      </Card>

      {isPending && <PageLoading />}
      {error && <ErrorState message={error.message} />}
      {archive.error && <Alert tone="danger" className="mb-4">{archive.error.message}</Alert>}
      {data && products.length === 0 && (
        <EmptyState
          icon="package"
          title="No products yet"
          description="Add your first product to start selling."
          action={<LinkButton to="/vendor/products/new" icon="plus">Add product</LinkButton>}
        />
      )}

      {products.length > 0 && (
        <>
          {/* Cards on phones, a table from tablet width up. */}
          <ul className="space-y-3 md:hidden">
            {products.map((p) => (
              <li key={p.id}>
                <Card className="flex gap-3 p-4!">
                  <Thumb product={p} />
                  <div className="min-w-0 flex-1">
                    <Link to={`/vendor/products/${p.id}`} className="line-clamp-2 font-medium text-slate-900 hover:text-brand-700">
                      {p.title}
                    </Link>
                    <p className="tabular mt-0.5 text-sm text-slate-600">
                      {formatINR(p.pricePaise)} · {p.stockQty} in stock
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <StatusBadge status={p.status} />
                      {p.status === 'active' && (
                        <Link to={`/products/${p.slug}`} className="text-sm font-medium text-brand-600">
                          View
                        </Link>
                      )}
                      {canArchive(p) && (
                        <Button variant="danger-outline" size="sm" disabled={archive.isPending} onClick={() => setToArchive(p)}>
                          Archive
                        </Button>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
          <div className="hidden md:block">
            <Table label="Your products">
              <THead>
                <Th>Product</Th>
                <Th num>Price</Th>
                <Th num>Stock</Th>
                <Th>Status</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </THead>
              <TBody>
                {products.map((p) => (
                  <tr key={p.id}>
                    <Td>
                      <div className="flex items-center gap-3">
                        <Thumb product={p} />
                        <Link to={`/vendor/products/${p.id}`} className="font-medium text-slate-900 hover:text-brand-700">
                          {p.title}
                        </Link>
                      </div>
                    </Td>
                    <Td num>{formatINR(p.pricePaise)}</Td>
                    <Td num>{p.stockQty}</Td>
                    <Td>
                      <StatusBadge status={p.status} />
                    </Td>
                    <Td>
                      <div className="flex items-center justify-end gap-2">
                        {p.status === 'active' && (
                          <Link to={`/products/${p.slug}`} className="text-sm font-medium text-brand-600 hover:underline">
                            View
                          </Link>
                        )}
                        {canArchive(p) && (
                          <Button variant="danger-outline" size="sm" disabled={archive.isPending} onClick={() => setToArchive(p)}>
                            Archive
                          </Button>
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </TBody>
            </Table>
          </div>
        </>
      )}
      <Pagination meta={meta} onPage={setPage} />

      <ConfirmDialog
        open={Boolean(toArchive)}
        title="Archive this product?"
        message={toArchive ? `\u201c${toArchive.title}\u201d will no longer be shown to customers.` : ''}
        confirmLabel="Archive"
        pending={archive.isPending}
        onConfirm={() => archive.mutate(toArchive.id)}
        onCancel={() => setToArchive(null)}
      />
    </>
  );
}