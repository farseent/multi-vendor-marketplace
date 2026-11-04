import { Link } from 'react-router-dom';
import { Icon } from './ui';

/**
 * Two-column frame for log in / sign up: a brand panel with the real selling points on large
 * screens, and the form card. On small screens only the card is shown.
 */
export default function AuthShell({ title, subtitle, points, children, footer }) {
  return (
    <div className="mx-auto grid max-w-6xl gap-0 px-4 py-8 sm:px-6 sm:py-12 lg:grid-cols-2 lg:px-8">
      <aside className="hidden flex-col justify-between rounded-l-2xl bg-brand-900 p-10 text-brand-100 lg:flex">
        <Link to="/" className="flex items-center gap-2.5 text-white">
          <span className="grid size-9 place-items-center rounded-lg bg-white/10">
            <Icon name="store" className="size-5" />
          </span>
          <span className="text-lg font-semibold">Marketplace</span>
        </Link>
        <ul className="space-y-6">
          {points.map(([icon, heading, text]) => (
            <li key={heading} className="flex gap-4">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
                <Icon name={icon} />
              </span>
              <div>
                <p className="font-semibold text-white">{heading}</p>
                <p className="mt-0.5 text-sm text-brand-200">{text}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="text-xs text-brand-300">One cart, many independent sellers.</p>
      </aside>
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card sm:p-10 lg:rounded-l-none lg:rounded-r-2xl">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1.5 text-sm text-slate-600">{subtitle}</p>}
        <div className="mt-6">{children}</div>
        {footer && <div className="mt-6 border-t border-slate-100 pt-5 text-sm text-slate-600">{footer}</div>}
      </div>
    </div>
  );
}