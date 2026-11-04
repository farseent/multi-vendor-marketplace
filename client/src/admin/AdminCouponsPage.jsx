import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
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
import Pager from './Pager.jsx';

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
  const note = (name) => errors[name] && <span className="error">{errors[name]}</span>;

  return (
    <form
      className="admin-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const result = couponRequest(form);
        setErrors(result.ok ? {} : result.errors);
        if (!result.ok) return;
        create.mutate(result.body, { onSuccess: () => setForm(EMPTY) });
      }}
    >
      <label>
        Code
        <input {...field('code')} maxLength={20} />
        {note('code')}
      </label>
      <label>
        Type
        <select
          value={form.type}
          onChange={(e) => setForm({ ...form, type: e.target.value, maxDiscount: '' })}
        >
          <option value="percent">Percent off</option>
          <option value="fixed">Fixed amount (₹)</option>
        </select>
      </label>
      <label>
        {form.type === 'percent' ? 'Percent (1-90)' : 'Amount (₹)'}
        <input {...field('value')} inputMode="decimal" />
        {note('value')}
      </label>
      <label>
        Minimum order (₹, optional)
        <input {...field('minOrder')} inputMode="decimal" />
        {note('minOrder')}
      </label>
      <label>
        Maximum discount (₹, percent only)
        <input {...field('maxDiscount')} inputMode="decimal" disabled={form.type !== 'percent'} />
        {note('maxDiscount')}
      </label>
      <label>
        Starts
        <input type="datetime-local" {...field('startsAt')} />
        {note('startsAt')}
      </label>
      <label>
        Ends
        <input type="datetime-local" {...field('expiresAt')} />
        {note('expiresAt')}
      </label>
      <label>
        Total uses (empty = unlimited)
        <input {...field('usageLimitTotal')} inputMode="numeric" />
        {note('usageLimitTotal')}
      </label>
      <label>
        Uses per customer
        <input {...field('usageLimitPerUser')} inputMode="numeric" />
        {note('usageLimitPerUser')}
      </label>
      <div className="wide">
        <button type="submit" disabled={create.isPending}>
          Create platform coupon
        </button>
        {create.error && (
          <p role="alert" className="error">
            {adminErrorMessage(create.error)}
          </p>
        )}
        <p className="muted">
          A platform coupon is paid for by the marketplace: vendors still receive their full payout.
        </p>
      </div>
    </form>
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
    <section>
      <h1>Platform coupons</h1>
      <CreateCouponForm />
      <div className="admin-filters">
        <label>
          Status
          <select
            value={filters.status}
            onChange={(e) => setFilters({ status: e.target.value, page: 1 })}
          >
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
      </div>
      {problem && (
        <p role="alert" className="error">
          {adminErrorMessage(problem)}
        </p>
      )}
      {isPending && <p>Loading…</p>}
      {data?.items.length === 0 && <p>No coupons yet.</p>}
      {data?.items.length > 0 && (
        <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Discount</th>
                <th scope="col">Minimum order</th>
                <th scope="col">Valid</th>
                <th scope="col" className="num">
                  Used
                </th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((c) => (
                <tr key={c.id}>
                  <th scope="row">{c.code}</th>
                  <td>{couponValueLabel(c)}</td>
                  <td>{c.minOrderPaise ? formatINR(c.minOrderPaise) : '—'}</td>
                  <td>
                    {new Date(c.startsAt).toLocaleDateString()} –{' '}
                    {new Date(c.expiresAt).toLocaleDateString()}
                  </td>
                  <td className="num">
                    {c.usedCount}
                    {c.usageLimitTotal ? ` / ${c.usageLimitTotal}` : ''}
                  </td>
                  <td>
                    <span className={`badge ${c.status === 'disabled' ? 'bad' : 'good'}`}>
                      {c.status}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      disabled={toggle.isPending}
                      onClick={() =>
                        toggle.mutate({
                          id: c.id,
                          status: c.status === 'active' ? 'disabled' : 'active',
                        })
                      }
                    >
                      {c.status === 'active' ? 'Disable' : 'Enable'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager meta={data?.meta} onPage={(page) => setFilters({ ...filters, page })} />
    </section>
  );
}
