import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, Card, CardHeader, ConfirmDialog, EmptyState, Field, Icon, PageHeader, PageLoading, Pagination, Select, StatusBadge, Table, TBody, Td, Th, THead } from '../components/ui';
import {
  adminErrorMessage,
  adminKey,
  adminList,
  adminSend,
  settlementStatusText,
} from '../lib/admin.js';
import { formatINR } from '../lib/money.js';
import { useAdminAction } from './hooks.js';

const STATUSES = ['not_eligible', 'pending_release', 'released', 'settled', 'reversed', 'failed'];

function Reconciliation() {
  const { data, error } = useQuery({
    queryKey: adminKey('reconciliation', {}),
    queryFn: () => adminList('reconciliation', { limit: 5 }),
  });
  const run = useAdminAction(() => adminSend('reconciliation/run', 'POST'));
  return (
    <Card className="mt-8">
      <CardHeader
        title="Reconciliation"
        description="Compares our payout records with the payment provider's transfers. It only reports: it never changes any payment, refund or settlement."
        actions={
          <Button variant="secondary" loading={run.isPending} onClick={() => run.mutate()}>
            <Icon name="refresh" className="size-4" />
            Run now
          </Button>
        }
      />
      {(error || run.error) && <Alert tone="danger">{adminErrorMessage(error ?? run.error)}</Alert>}
      {data?.items.length === 0 && <p className="text-sm text-slate-500">No report yet.</p>}
      <div className="space-y-2">
        {data?.items.map((r) => (
          <details key={r.id} className="group rounded-lg border border-slate-200 bg-slate-50/60 p-3 text-sm">
            <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium text-slate-900">{new Date(r.runAt).toLocaleString()}</span>
              <StatusBadge status={r.status} />
              <span className="text-slate-500">
                {r.totals.settlementsChecked} checked, {r.totals.mismatchCount} mismatches
              </span>
            </summary>
            {r.mismatches.length === 0 ? (
              <p className="mt-3 text-slate-600">Nothing to report.</p>
            ) : (
              <ul className="mt-3 list-disc space-y-1 pl-5 text-slate-700">
                {r.mismatches.map((m, i) => (
                  <li key={`${r.id}-${i}`}>
                    {m.type.replaceAll('_', ' ')}
                    {m.detail ? `: ${m.detail}` : ''}
                    {m.expected !== undefined ? ` (expected ${m.expected}, found ${m.actual})` : ''}
                  </li>
                ))}
              </ul>
            )}
          </details>
        ))}
      </div>
    </Card>
  );
}

/** Vendor payouts across the marketplace, an early-release button, and the reconciliation report. */
export default function AdminSettlementsPage() {
  const [filters, setFilters] = useState({ status: '', page: 1 });
  const [toRelease, setToRelease] = useState(null);
  const { data, error, isPending } = useQuery({
    queryKey: adminKey('settlements', filters),
    queryFn: () => adminList('settlements', filters),
    placeholderData: keepPreviousData,
  });
  const release = useAdminAction((id) => adminSend(`settlements/${id}/release`, 'POST'));
  const problem = error ?? release.error;

  return (
    <>
      <PageHeader title="Settlements" description="Vendor payouts across the marketplace." />
      <Card className="mb-6">
        <Field label="Status" className="max-w-xs">
          <Select value={filters.status} onChange={(e) => setFilters({ status: e.target.value, page: 1 })}>
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {settlementStatusText(s)}
              </option>
            ))}
          </Select>
        </Field>
      </Card>
      {problem && <Alert tone="danger" className="mb-4">{adminErrorMessage(problem)}</Alert>}
      {isPending && <PageLoading />}
      {data?.items.length === 0 && <EmptyState icon="wallet" title="No settlements match" />}
      {data?.items.length > 0 && (
        <Table label="Settlements">
          <THead>
            <Th>Sub-order</Th>
            <Th num>Gross</Th>
            <Th num>Commission</Th>
            <Th num>Refunds</Th>
            <Th num>Net payout</Th>
            <Th>Status</Th>
            <Th>Action</Th>
          </THead>
          <TBody>
            {data.items.map((s) => (
              <tr key={s.id}>
                <Td header>{s.subOrderNumber}</Td>
                <Td num>{formatINR(s.grossPaise)}</Td>
                <Td num>{formatINR(s.commissionPaise)}</Td>
                <Td num>{s.refundAdjustmentPaise ? formatINR(s.refundAdjustmentPaise) : '—'}</Td>
                <Td num className="font-semibold text-slate-900">{formatINR(s.netPayoutPaise)}</Td>
                <Td>
                  <StatusBadge status={s.status} label={settlementStatusText(s.status)} className="capitalize" />
                  {s.failureReason && <p className="mt-1 text-xs text-slate-500">{s.failureReason}</p>}
                </Td>
                <Td>
                  {s.status === 'pending_release' && (
                    <Button variant="secondary" size="sm" disabled={release.isPending} onClick={() => setToRelease(s.id)}>
                      Release early
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </TBody>
        </Table>
      )}
      <Pagination meta={data?.meta} onPage={(page) => setFilters({ ...filters, page })} showTotal />
      <Reconciliation />
      <ConfirmDialog
        open={Boolean(toRelease)}
        title="Release this payout now?"
        message="This pays the vendor before the 7-day return window ends."
        confirmLabel="Release payout"
        tone="primary"
        pending={release.isPending}
        onConfirm={() => release.mutate(toRelease, { onSettled: () => setToRelease(null) })}
        onCancel={() => setToRelease(null)}
      />
    </>
  );
}