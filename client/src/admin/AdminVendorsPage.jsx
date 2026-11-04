import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, Card, ConfirmDialog, EmptyState, Field, Input, PageHeader, PageLoading, Pagination, Select, StatusBadge, Table, TBody, Td, Th, THead } from '../components/ui';
import {
  adminErrorMessage,
  adminKey,
  adminList,
  adminSend,
  bpsToPercent,
  percentToBps,
  vendorNextStatuses,
} from '../lib/admin.js';
import { useAdminAction } from './hooks.js';

const STATUSES = ['', 'pending', 'approved', 'rejected', 'suspended'];
const VERBS = { approved: 'Approve', rejected: 'Reject', suspended: 'Suspend' };
const VERB_VARIANT = { approved: 'primary', rejected: 'danger-outline', suspended: 'danger-outline' };

function CommissionForm({ vendor, onSave, disabled }) {
  const [text, setText] = useState(bpsToPercent(vendor.commissionRateBps));
  const bps = percentToBps(text);
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (bps !== undefined) onSave(bps);
      }}
    >
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="default"
        className="w-24"
        inputMode="decimal"
        aria-label={`Commission percent for ${vendor.shopName}`}
        aria-invalid={bps === undefined}
      />
      <span aria-hidden="true" className="text-sm text-slate-500">
        %
      </span>
      <Button type="submit" variant="secondary" size="sm" disabled={disabled || bps === undefined}>
        Save
      </Button>
    </form>
  );
}

/** Approve, reject or suspend shops and set a shop's own commission rate. */
export default function AdminVendorsPage() {
  const [filters, setFilters] = useState({ status: '', page: 1 });
  const [pending, setPending] = useState(null); // { vendor, status } waiting for confirmation
  const { data, error, isPending } = useQuery({
    queryKey: adminKey('vendors', filters),
    queryFn: () => adminList('vendors', filters),
    placeholderData: keepPreviousData,
  });
  const setStatus = useAdminAction(({ id, status }) =>
    adminSend(`vendors/${id}/status`, 'PATCH', { status }),
  );
  const setCommission = useAdminAction(({ id, bps }) =>
    adminSend(`vendors/${id}/commission`, 'PATCH', { commissionRateBps: bps }),
  );
  const problem = error ?? setStatus.error ?? setCommission.error;

  return (
    <>
      <PageHeader title="Vendors" description="Approve shops and set the commission each one pays." />
      <Card className="mb-6">
        <Field label="Status" className="max-w-xs">
          <Select value={filters.status} onChange={(e) => setFilters({ status: e.target.value, page: 1 })}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s || 'All'}
              </option>
            ))}
          </Select>
        </Field>
      </Card>
      {problem && <Alert tone="danger" className="mb-4">{adminErrorMessage(problem)}</Alert>}
      {isPending && <PageLoading />}
      {data?.items.length === 0 && <EmptyState icon="store" title="No shops match" />}
      {data?.items.length > 0 && (
        <Table label="Vendors">
          <THead>
            <Th>Shop</Th>
            <Th>Owner</Th>
            <Th>Status</Th>
            <Th>Commission</Th>
            <Th>Actions</Th>
          </THead>
          <TBody>
            {data.items.map((v) => (
              <tr key={v.id}>
                <Td header>{v.shopName}</Td>
                <Td>{v.owner ? `${v.owner.name} (${v.owner.email})` : ''}</Td>
                <Td>
                  <StatusBadge status={v.status} />
                </Td>
                <Td>
                  <CommissionForm
                    key={`${v.id}-${v.commissionRateBps}`}
                    vendor={v}
                    disabled={setCommission.isPending}
                    onSave={(bps) => setCommission.mutate({ id: v.id, bps })}
                  />
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-2">
                    {vendorNextStatuses(v.status).map((status) => (
                      <Button
                        key={status}
                        variant={VERB_VARIANT[status] ?? 'secondary'}
                        size="sm"
                        disabled={setStatus.isPending}
                        onClick={() =>
                          status === 'approved'
                            ? setStatus.mutate({ id: v.id, status })
                            : setPending({ vendor: v, status })
                        }
                      >
                        {VERBS[status]}
                      </Button>
                    ))}
                  </div>
                </Td>
              </tr>
            ))}
          </TBody>
        </Table>
      )}
      <Pagination meta={data?.meta} onPage={(page) => setFilters({ ...filters, page })} showTotal />
      <ConfirmDialog
        open={Boolean(pending)}
        title={pending ? `${VERBS[pending.status]} ${pending.vendor.shopName}?` : ''}
        message={
          pending?.status === 'suspended'
            ? 'Its products are hidden from customers until the shop is approved again.'
            : 'The shop will not be able to sell on the marketplace.'
        }
        confirmLabel={pending ? VERBS[pending.status] : 'Confirm'}
        pending={setStatus.isPending}
        onConfirm={() =>
          setStatus.mutate(
            { id: pending.vendor.id, status: pending.status },
            { onSettled: () => setPending(null) },
          )
        }
        onCancel={() => setPending(null)}
      />
    </>
  );
}