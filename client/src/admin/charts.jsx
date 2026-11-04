import { Card, CardHeader, Table, TBody, Td, Th, THead } from '../components/ui';
import { formatINR } from '../lib/money.js';
import { barLayout, percentOf } from '../lib/admin.js';

/** GMV per day (or month) as an SVG bar chart, with the same numbers in a table for screen readers. */
export function SalesChart({ points }) {
  const { max, bars } = barLayout(points, 'gmvPaise');
  const first = points[0]?.bucket;
  const last = points.at(-1)?.bucket;
  return (
    <figure>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2.5 rounded-sm bg-brand-500" />
          GMV (paid orders) per {points.length > 31 ? 'period' : 'day'}
        </span>
        <span className="text-slate-500">Hover or focus a bar for its exact value.</span>
      </div>
      <svg
        className="h-auto w-full"
        viewBox="0 0 720 220"
        role="img"
        aria-label={`Sales per ${points.length > 31 ? 'period' : 'day'} from ${first} to ${last}, highest ${formatINR(max)}`}
      >
        <line x1="24" y1="24" x2="696" y2="24" className="stroke-slate-200" strokeDasharray="4 4" />
        <line
          x1="24"
          y1="110"
          x2="696"
          y2="110"
          className="stroke-slate-200"
          strokeDasharray="4 4"
        />
        <line x1="24" y1="196" x2="696" y2="196" className="stroke-slate-300" />
        {bars.map((b) => (
          <rect
            key={b.bucket}
            className="fill-brand-500 transition-colors hover:fill-brand-700"
            rx="2"
            x={b.x}
            y={b.y}
            width={b.width}
            height={b.height}
          >
            <title>{`${b.bucket}: ${formatINR(b.value)}`}</title>
          </rect>
        ))}
        <text
          x="24"
          y="14"
          className="fill-slate-600 stroke-white stroke-[3px] text-[11px] [paint-order:stroke]"
        >
          {formatINR(max)}
        </text>
        <text
          x="24"
          y="102"
          className="fill-slate-600 stroke-white stroke-[3px] text-[11px] [paint-order:stroke]"
        >
          {formatINR(Math.round(max / 2))}
        </text>
        <text x="24" y="213" className="fill-slate-500 text-[11px]">
          {first}
        </text>
        <text x="696" y="213" textAnchor="end" className="fill-slate-500 text-[11px]">
          {last}
        </text>
      </svg>
      <details className="mt-4 rounded-lg border border-slate-200 bg-slate-50/60 p-3 text-sm">
        <summary className="cursor-pointer font-medium text-slate-700">
          Show the figures as a table
        </summary>
        <div className="mt-3">
          <Table label="Sales figures" className="max-h-80 overflow-y-auto">
            <THead>
              <Th>Period</Th>
              <Th num>Orders</Th>
              <Th num>GMV</Th>
            </THead>
            <TBody>
              {points.map((p) => (
                <tr key={p.bucket}>
                  <Td header>{p.bucket}</Td>
                  <Td num>{p.orderCount}</Td>
                  <Td num>{formatINR(p.gmvPaise)}</Td>
                </tr>
              ))}
            </TBody>
          </Table>
        </div>
      </details>
    </figure>
  );
}

/** A ranked table with a proportional bar in the last column (top vendors, top products). */
export function RankedTable({ title, rows, columns }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <Card padded={false}>
      <div className="px-5 pt-5 sm:px-6">
        <CardHeader title={title} />
      </div>
      {rows.length === 0 ? (
        <p className="px-5 pb-6 text-sm text-slate-500 sm:px-6">No sales in this range.</p>
      ) : (
        <Table label={title} flush className="border-t border-slate-200">
          <THead>
            <Th>Name</Th>
            {columns.map((c) => (
              <Th key={c.label} num>
                {c.label}
              </Th>
            ))}
            <Th>Share of top</Th>
          </THead>
          <TBody>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td header>{r.name}</Td>
                {columns.map((c) => (
                  <Td key={c.label} num>
                    {c.render(r.raw)}
                  </Td>
                ))}
                <Td className="min-w-28">
                  <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full min-w-0.5 rounded-full bg-brand-500"
                      style={{ width: `${percentOf(r.value, max)}%` }}
                    />
                  </div>
                  <span className="sr-only">{percentOf(r.value, max)}% of the top figure</span>
                </Td>
              </tr>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
