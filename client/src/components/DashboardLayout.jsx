import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { Icon } from './ui';
import { cx } from './ui/classes.js';

/**
 * Shared shell of the vendor and admin consoles: a sidebar on large screens, a slide-in drawer on
 * small ones, and the page below. `tone` picks a dark (admin) or light (vendor) sidebar; the
 * colours otherwise come from the same tokens as the storefront. UX only: the API checks roles.
 */
export default function DashboardLayout({ title, links, tone = 'light', maxWidth = 'max-w-7xl' }) {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const dark = tone === 'dark';

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const linkClass = ({ isActive }) =>
    cx(
      'flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
      dark
        ? isActive
          ? 'bg-white/10 text-white'
          : 'text-slate-300 hover:bg-white/5 hover:text-white'
        : isActive
          ? 'bg-brand-50 text-brand-700'
          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
    );
  const muted = dark ? 'text-slate-400' : 'text-slate-500';

  return (
    <div className="min-h-dvh lg:flex">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-60 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-float"
      >
        Skip to content
      </a>

      {/* Top bar, small screens only */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4 lg:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          aria-expanded={open}
          aria-controls="dashboard-nav"
          className="-ml-2 grid size-11 place-items-center rounded-lg text-slate-600 hover:bg-slate-100"
        >
          <Icon name="menu" />
        </button>
        <span className="font-semibold text-slate-900">{title}</span>
      </header>

      {open && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/50 lg:hidden"
          aria-hidden="true"
          onClick={() => setOpen(false)}
        />
      )}

      <aside
        id="dashboard-nav"
        className={cx(
          'fixed inset-y-0 left-0 z-50 flex w-72 flex-col transition-transform lg:sticky lg:top-0 lg:z-auto lg:h-dvh lg:w-64 lg:shrink-0 lg:translate-x-0',
          dark ? 'bg-slate-900' : 'border-r border-slate-200 bg-white',
          open ? 'translate-x-0' : '-translate-x-full max-lg:invisible',
        )}
      >
        <div className="flex h-16 shrink-0 items-center justify-between px-5">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-lg bg-brand-600 text-white">
              <Icon name="store" className="size-4.5" />
            </span>
            <span className="leading-tight">
              <span className={cx('block text-sm font-semibold', dark ? 'text-white' : 'text-slate-900')}>
                {title}
              </span>
              <span className={cx('block text-xs', muted)}>Marketplace</span>
            </span>
          </Link>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
            className={cx(
              'grid size-10 place-items-center rounded-lg lg:hidden',
              dark ? 'text-slate-300 hover:bg-white/10' : 'text-slate-500 hover:bg-slate-100',
            )}
          >
            <Icon name="x" />
          </button>
        </div>

        <nav aria-label={title} className="flex-1 overflow-y-auto px-3 py-2">
          <ul className="space-y-1">
            {links.map(({ to, label, icon, end }) => (
              <li key={to}>
                <NavLink to={to} end={end} className={linkClass} onClick={() => setOpen(false)}>
                  <Icon name={icon} className="size-4.5" />
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className={cx('shrink-0 border-t p-3', dark ? 'border-white/10' : 'border-slate-200')}>
          <div className="mb-2 flex items-center gap-3 px-2 py-1.5">
            <span
              aria-hidden="true"
              className="grid size-9 place-items-center rounded-full bg-brand-600 text-sm font-semibold uppercase text-white"
            >
              {user?.name?.[0] ?? '?'}
            </span>
            <span className="min-w-0 leading-tight">
              <span className={cx('block truncate text-sm font-medium', dark ? 'text-white' : 'text-slate-900')}>
                {user?.name}
              </span>
              <span className={cx('block truncate text-xs capitalize', muted)}>{user?.role}</span>
            </span>
          </div>
          <NavLink to="/" end className={linkClass}>
            <Icon name="external" className="size-4.5" />
            View store
          </NavLink>
          <NavLink to="/account" className={linkClass}>
            <Icon name="user" className="size-4.5" />
            Account
          </NavLink>
          <button
            type="button"
            onClick={() => logout()}
            className={cx(
              'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
              dark
                ? 'text-slate-300 hover:bg-white/5 hover:text-white'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
            )}
          >
            <Icon name="log-out" className="size-4.5" />
            Log out
          </button>
        </div>
      </aside>

      <main id="main" className="min-w-0 flex-1">
        <div className={cx('mx-auto w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8', maxWidth)}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}