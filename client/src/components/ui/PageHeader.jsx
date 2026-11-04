import { Link } from 'react-router-dom';
import Icon from './Icon.jsx';
import { cx } from './classes.js';

/** Page title block: optional back link, title, description and actions (buttons) on the right. */
export default function PageHeader({ title, description, actions, back, className }) {
  return (
    <div className={cx('mb-6', className)}>
      {back && (
        <Link
          to={back.to}
          className="mb-2 inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-brand-700"
        >
          <Icon name="arrow-left" className="size-4" />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
            {title}
          </h1>
          {description && <p className="mt-1 max-w-2xl text-sm text-slate-600">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
