import Icon from './Icon.jsx';
import { cx } from './classes.js';

export const Spinner = ({ className }) => (
  <span
    aria-hidden="true"
    className={cx(
      'inline-block size-5 animate-spin rounded-full border-2 border-brand-600 border-r-transparent',
      className,
    )}
  />
);

/** Grey placeholder block shown while content loads. */
export const Skeleton = ({ className }) => (
  <div aria-hidden="true" className={cx('animate-pulse rounded-md bg-slate-200/70', className)} />
);

/** Centered spinner with a text label (announced to screen readers). */
export const PageLoading = ({ label = 'Loading…', className }) => (
  <div
    role="status"
    className={cx('flex items-center justify-center gap-3 py-16 text-sm text-slate-500', className)}
  >
    <Spinner />
    {label}
  </div>
);

export function EmptyState({ icon = 'package', title, description, action, className }) {
  return (
    <div
      className={cx(
        'flex flex-col items-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center',
        className,
      )}
    >
      <span className="mb-4 grid size-12 place-items-center rounded-full bg-slate-100 text-slate-500">
        <Icon name={icon} className="size-6" />
      </span>
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      {description && <p className="mt-1 max-w-md text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ title = 'Something went wrong', message, action, className }) {
  return (
    <div
      role="alert"
      className={cx(
        'flex flex-col items-center rounded-xl border border-red-200 bg-red-50 px-6 py-12 text-center',
        className,
      )}
    >
      <span className="mb-4 grid size-12 place-items-center rounded-full bg-red-100 text-red-600">
        <Icon name="alert-circle" className="size-6" />
      </span>
      <h2 className="text-base font-semibold text-red-900">{title}</h2>
      {message && <p className="mt-1 max-w-md text-sm text-red-800">{message}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
