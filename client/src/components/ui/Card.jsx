import { cx } from './classes.js';

export function Card({ as: Tag = 'div', className, padded = true, children, ...props }) {
  return (
    <Tag
      className={cx(
        'rounded-xl border border-slate-200 bg-white shadow-card',
        padded && 'p-5 sm:p-6',
        className,
      )}
      {...props}
    >
      {children}
    </Tag>
  );
}

/** Title row inside a card: heading, optional description, optional actions on the right. */
export function CardHeader({ title, description, actions, as: Tag = 'h2', className }) {
  return (
    <div className={cx('mb-4 flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <Tag className="text-base font-semibold text-slate-900">{title}</Tag>
        {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
      </div>
      {actions}
    </div>
  );
}
