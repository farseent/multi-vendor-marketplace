import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input, PageHeader, PageLoading, Pagination, Select, StatusBadge, Table, TBody, Td, Th, THead } from '../components/ui';
import {
  adminErrorMessage,
  adminKey,
  adminList,
  adminSend,
  couponRequest,
  couponValueLabel,
} from '../lib/admin.js';
import { formatINR } from '../lib/money.js';
import { useAdminAction } from './hooks.js';

const EMPTY = {
  code: '',
  type: 'percent',
  value: '',
  minOrder: '',
  maxDiscount: '',
  startsAt: '',
  expiresAt: '',
  usageLimitTotal: '',
  usageLimitPerUser: '1',
};

function CreateCouponForm() {
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const create = useAdminAction((body) => adminSend('coupons', 'POST', body));
  const field = (name) => ({
    value: form[name],
    onChange: (e) => setForm({ ...form, [name]: e.target.value }),
    'aria-invalid': Boolean(errors[name]),
  });

  return (
    <Card className="mb-6">
      <CardHeader
        title="Create a platform coupon"
        description="A platform coupon is paid for by the marketplace: vendors still receive their full payout."
      />
      <form
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const result = couponRequest(form);
          setErrors(result.ok ? {} : result.errors);
          if (!result.ok) return;
          create.mutate(result.body, { onSuccess: () => setForm(EMPTY) });
        }}
      >
        <Field label="Code" error={errors.code}>
          <Input {...field('code')} maxLength={20} />
        </Field>
        <Field label="Type">
          <Select
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value, maxDiscount: '' })}
          >
            <option value="percent">Percent off</option>
            <option value="fixed">Fixed amount (₹)</option>
          </Select>
        </Field>
        <Field label={form.type === 'percent' ? 'Percent (1-90)' : 'Amount (₹)'} error={errors.value}>
          <Input {...field('value')} inputMode="decimal" />
        </Field>
        <Field label="Minimum order (₹, optional)" error={errors.minOrder}>
          <Input {...field('minOrder')} inputMode="decimal" />
        </Field>
        <Field label="Maximum discount (₹, percent only)" error={errors.maxDiscount}>
          <Input {...field('maxDiscount')} inputMode="decimal" disabled={form.type !== 'percent'} />
        </Field>
        <Field label="Starts" error={errors.startsAt}>
          <Input type="datetime-local" {...field('startsAt')} />
        </Field>
        <Field label="Ends" error={errors.expiresAt}>
          <Input type="datetime-local" {...field('expiresAt')} />
        </Field>
        <Field label="Total uses (empty = unlimited)" error={errors.usageLimitTotal}>
          <Input {...field('usageLimitTotal')} inputMode="numeric" />
        </Field>
        <Field label="Uses per customer" error={errors.usageLimitPerUser}>
          <Input {...field('usageLimitPerUser')} inputMode="numeric" />
        </Field>
        <div className="space-y-3 sm:col-span-2 lg:col-span-3">
          {create.error && <Alert tone="danger">{adminErrorMessage(create.error)}</Alert>}
          <Button type="submit" loading={create.isPending}>
            Create platform coupon
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Platform coupons: create one, and switch it on or off. */
export default function AdminCouponsPage() {
  const [filters, setFilters] = useState({ status: '', page: 1 });
  const { data, error, isPending } = useQuery({
    queryKey: adminKey('coupons', filters),
    queryFn: () => adminList('coupons', filters),
    placeholderData: keepPreviousData,
  });
  const toggle = useAdminAction(({ id, status }) =>
    adminSend(`coupons/${id}`, 'PATCH', { status }),
  );
  const problem = error ?? toggle.error;

  return (
    <>
      <PageHeader title="Platform coupons" />
      <CreateCouponForm />
      <Card className="mb-6">
        <Field label="Status" className="max-w-xs">
          <Select value={filters.status} onChange={(e) => setFilters({ status: e.target.value, page: 1 })}>
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </Select>
        </Field>
      </Card>
      {problem && <Alert tone="danger" className="mb-4">{adminErrorMessage(problem)}</Alert>}
      {isPending && <PageLoading />}
      {data?.items.length === 0 && <EmptyState icon="tag" title="No coupons yet" description="Create one with the form above." />}
      {data?.items.length > 0 && (
        <Table label="Platform coupons">
          <THead>
            <Th>Code</Th>
            <Th>Discount</Th>
            <Th>Minimum order</Th>
            <Th>Valid</Th>
            <Th num>Used</Th>
            <Th>Status</Th>
            <Th>Action</Th>
          </THead>
          <TBody>
            {data.items.map((c) => (
              <tr key={c.id}>
                <Td header className="font-mono">{c.code}</Td>
                <Td>{couponValueLabel(c)}</Td>
                <Td>{c.minOrderPaise ? formatINR(c.minOrderPaise) : '—'}</Td>
                <Td className="whitespace-nowrap">
                  {new Date(c.startsAt).toLocaleDateString()} – {new Date(c.expiresAt).toLocaleDateString()}
                </Td>
                <Td num>
                  {c.usedCount}
                  {c.usageLimitTotal ? ` / ${c.usageLimitTotal}` : ''}
                </Td>
                <Td>
                  <StatusBadge status={c.status} />
                </Td>
                <Td>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={toggle.isPending}
                    onClick={() =>
                      toggle.mutate({ id: c.id, status: c.status === 'active' ? 'disabled' : 'active' })
                    }
                  >
                    {c.status === 'active' ? 'Disable' : 'Enable'}
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