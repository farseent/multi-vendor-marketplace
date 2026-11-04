import Icon from './Icon.jsx';
import { cx } from './classes.js';

const TONES = {
  info: ['border-sky-200 bg-sky-50 text-sky-900', 'info', 'text-sky-600'],
  success: [
    'border-emerald-200 bg-emerald-50 text-emerald-900',
    'check-circle',
    'text-emerald-600',
  ],
  warning: ['border-amber-200 bg-amber-50 text-amber-900', 'alert', 'text-amber-600'],
  danger: ['border-red-200 bg-red-50 text-red-800', 'alert-circle', 'text-red-600'],
};

/** Inline message. Errors are announced immediately (role="alert"), everything else politely. */
export function Alert({ tone = 'info', title, children, className, role }) {
  const [box, icon, iconColor] = TONES[tone];
  return (
    <div
      role={role ?? (tone === 'danger' ? 'alert' : 'status')}
      className={cx('flex gap-3 rounded-lg border p-3.5 text-sm', box, className)}
    >
      <Icon name={icon} className={cx('mt-0.5 size-4.5', iconColor)} />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? 'mt-0.5' : undefined}>{children}</div>}
      </div>
    </div>
  );
}
