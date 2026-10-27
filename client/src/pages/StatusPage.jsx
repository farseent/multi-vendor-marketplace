import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api.js';

const LABELS = { mongo: 'MongoDB', redis: 'Redis', elasticsearch: 'Elasticsearch' };

export default function StatusPage() {
  const { data, error, isPending, refetch, isFetching } = useQuery({
    queryKey: ['health', 'ready'],
    queryFn: () => apiFetch('/health/ready'),
    retry: false,
  });

  // A 503 still carries the component list in error.details, so show it.
  const report = data?.data ?? (error?.code === 'SERVICE_UNAVAILABLE' ? error.details : null);

  return (
    <>
      <h1>System status</h1>
      {isPending && <p>Checking…</p>}
      {error && !report && (
        <p role="alert">
          Cannot reach the API. Start the backend with <code>npm run dev:server</code>.
        </p>
      )}
      {report && (
        <>
          <p>
            Overall: <strong>{report.status}</strong>
          </p>
          <ul className="components">
            {Object.entries(report.components).map(([name, c]) => (
              <li key={name} className={c.status}>
                {LABELS[name] ?? name}: {c.status}
                {c.status === 'up' && ` (${c.latencyMs} ms)`}
                {!c.required && c.status === 'down' && ' – optional, site keeps working'}
              </li>
            ))}
          </ul>
        </>
      )}
      <button type="button" onClick={() => refetch()} disabled={isFetching}>
        Check again
      </button>
    </>
  );
}