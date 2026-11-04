/** Previous / next for any admin list (`meta` is the API's { page, totalPages, total }). */
export default function Pager({ meta, onPage }) {
  if (!meta || meta.totalPages <= 1)
    return meta ? <p className="muted">{meta.total} in total</p> : null;
  return (
    <nav className="admin-pager" aria-label="Pages">
      <button type="button" disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)}>
        Previous
      </button>
      <span>
        Page {meta.page} of {meta.totalPages} ({meta.total} in total)
      </span>
      <button
        type="button"
        disabled={meta.page >= meta.totalPages}
        onClick={() => onPage(meta.page + 1)}
      >
        Next
      </button>
    </nav>
  );
}
