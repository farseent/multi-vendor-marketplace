import { Button } from './Button.jsx';
import Icon from './Icon.jsx';

/** Previous / next for any paged list. `meta` is the API's { page, totalPages, total }. */
export default function Pagination({ meta, onPage, label = 'Pages', showTotal = false }) {
  if (!meta) return null;
  if (meta.totalPages <= 1) {
    return showTotal ? <p className="mt-4 text-sm text-slate-500">{meta.total} in total</p> : null;
  }
  return (
    <nav aria-label={label} className="mt-6 flex items-center justify-between gap-3">
      <Button variant="secondary" size="sm" disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)}>
        <Icon name="chevron-left" className="size-4" />
        Previous
      </Button>
      <p className="text-center text-sm text-slate-600" aria-live="polite">
        Page {meta.page} of {meta.totalPages}
        {showTotal && <span className="hidden sm:inline"> · {meta.total} in total</span>}
      </p>
      <Button
        variant="secondary"
        size="sm"
        disabled={meta.page >= meta.totalPages}
        onClick={() => onPage(meta.page + 1)}
      >
        Next
        <Icon name="chevron-right" className="size-4" />
      </Button>
    </nav>
  );
}