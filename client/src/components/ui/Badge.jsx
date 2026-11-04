import { cx } from './classes.js';
import { humanize, statusTone } from './status.js';

const TONE_CLASSES = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  success: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20',
  warning: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  danger: 'bg-red-50 text-red-700 ring-red-600/20',
  info: 'bg-sky-50 text-sky-800 ring-sky-600/20',
  brand: 'bg-brand-50 text-brand-700 ring-brand-600/20',
};

export function Badge({ tone = 'neutral', className, children }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Badge whose colour follows the status word (see status.js). `label` overrides the text. */
export function StatusBadge({ status, label, className }) {
  return (
    <Badge tone={statusTone(status)} className={cx(label === undefined && 'capitalize', className)}>
      {label ?? humanize(status)}
    </Badge>
  );
}