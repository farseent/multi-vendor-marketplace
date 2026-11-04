import { formatINR } from '../lib/money.js';
import { barLayout, percentOf } from '../lib/admin.js';

/** GMV per day (or month) as an SVG bar chart, with the same numbers in a table for screen readers. */
export function SalesChart({ points }) {
  const { max, bars } = barLayout(points, 'gmvPaise');
  const first = points[0]?.bucket;
  const last = points.at(-1)?.bucket;
  return (
    <figure>
      <svg
        className="chart"
        viewBox="0 0 720 220"
        role="img"
        aria-label={`Sales per ${points.length > 31 ? 'period' : 'day'} from ${first} to ${last}, highest ${formatINR(max)}`}
      >
        <line x1="24" y1="196" x2="696" y2="196" stroke="currentColor" opacity="0.3" />
        {bars.map((b) => (
          <rect key={b.bucket} className="bar" x={b.x} y={b.y} width={b.width} height={b.height}>
            <title>{`${b.bucket}: ${formatINR(b.value)}`}</title>
          </rect>
        ))}
        <text x="24" y="12">
          {formatINR(max)}
        </text>
        <text x="24" y="214">
          {first}
        </text>
        <text x="696" y="214" textAnchor="end">
          {last}
        </text>
      </svg>
      <details>
        <summary>Show the figures as a table</summary>
        <table className="admin-table">
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col" className="num">
                Orders
              </th>
              <th scope="col" className="num">
                GMV
              </th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.bucket}>
                <th scope="row">{p.bucket}</th>
                <td className="num">{p.orderCount}</td>
                <td className="num">{formatINR(p.gmvPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** A ranked table with a proportional bar in the last column (top vendors, top products). */
export function RankedTable({ title, rows, columns }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <section>
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="muted">No sales in this range.</p>
      ) : (
        <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                {columns.map((c) => (
                  <th key={c.label} scope="col" className="num">
                    {c.label}
                  </th>
                ))}
                <th scope="col">
                  <span className="muted">Share of top</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row">{r.name}</th>
                  {columns.map((c) => (
                    <td key={c.label} className="num">
                      {c.render(r.raw)}
                    </td>
                  ))}
                  <td style={{ minWidth: '6rem' }}>
                    <span
                      className="hbar"
                      style={{ width: `${percentOf(r.value, max)}%` }}
                      aria-hidden="true"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
