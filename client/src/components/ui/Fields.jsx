import { cx, inputClasses } from './classes.js';

export const Input = ({ className, ...props }) => (
  <input className={cx(inputClasses, className)} {...props} />
);

export const Select = ({ className, children, ...props }) => (
  <select className={cx(inputClasses, 'pr-8', className)} {...props}>
    {children}
  </select>
);

export const Textarea = ({ className, ...props }) => (
  <textarea className={cx(inputClasses, 'min-h-24', className)} {...props} />
);

export const Checkbox = ({ label, className, ...props }) => (
  <label
    className={cx(
      'flex min-h-10 cursor-pointer items-center gap-2.5 text-sm text-slate-700',
      className,
    )}
  >
    <input
      type="checkbox"
      className="size-4 rounded border-slate-300 text-brand-600 accent-brand-600"
      {...props}
    />
    {label}
  </label>
);

/**
 * A label wrapped around its control, so the two are tied together without ids.
 * `hint` is helper text, `error` is a validation message (announced to screen readers).
 */
export function Field({ label, hint, error, className, children }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-slate-500">{hint}</span>}
      {error && (
        <span role="alert" className="mt-1.5 block text-xs font-medium text-red-600">
          {error}
        </span>
      )}
    </label>
  );
}
