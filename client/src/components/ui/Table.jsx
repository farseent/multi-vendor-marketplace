import { cx } from './classes.js';

/**
 * Scrollable table shell: on narrow screens the table scrolls sideways inside its own box, so the
 * page never overflows. `label` names the scroll region for screen-reader and keyboard users.
 */
export function Table({ label, className, flush = false, children }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cx(
        'relative overflow-x-auto bg-white',
        !flush && 'rounded-xl border border-slate-200 shadow-card',
        className,
      )}
    >
      <table className="min-w-full divide-y divide-slate-200 text-sm">{children}</table>
    </div>
  );
}

export const THead = ({ children }) => (
  <thead className="bg-slate-50">
    <tr>{children}</tr>
  </thead>
);

export const TBody = ({ children }) => (
  <tbody className="divide-y divide-slate-100">{children}</tbody>
);

export const Th = ({ num = false, className, children }) => (
  <th
    scope="col"
    className={cx(
      'whitespace-nowrap px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500',
      num ? 'text-right' : 'text-left',
      className,
    )}
  >
    {children}
  </th>
);

/** Table cell. `header` makes it the row header (<th scope="row">), `num` right-aligns figures. */
export function Td({ header = false, num = false, className, children, ...props }) {
  const Tag = header ? 'th' : 'td';
  return (
    <Tag
      scope={header ? 'row' : undefined}
      className={cx(
        'px-4 py-3 align-middle',
        header ? 'text-left font-medium text-slate-900' : 'text-slate-700',
        num && 'tabular text-right',
        className,
      )}
      {...props}
    >
      {children}
    </Tag>
  );
}
