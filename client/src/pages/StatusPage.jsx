import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Container, Icon, PageHeader, PageLoading, StatusBadge } from '../components/ui';
import { cx } from '../components/ui/classes.js';
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
    <Container narrow className="py-8 sm:py-10">
      <PageHeader
        title="System status"
        description="Whether the API and the services behind it are running."
        actions={
          <Button variant="secondary" onClick={() => refetch()} loading={isFetching}>
            <Icon name="refresh" className="size-4" />
            Check again
          </Button>
        }
      />
      {isPending && <PageLoading label="Checking…" />}
      {error && !report && (
        <Alert tone="danger">
          Cannot reach the API. Start the backend with <code className="font-mono">npm run dev:server</code>.
        </Alert>
      )}
      {report && (
        <div className="space-y-4">
          <Card className="flex items-center justify-between gap-3">
            <p className="font-medium text-slate-900">Overall</p>
            <StatusBadge status={report.status} />
          </Card>
          <Card padded={false}>
            <ul className="divide-y divide-slate-100">
              {Object.entries(report.components).map(([name, c]) => (
                <li key={name} className="flex flex-wrap items-center gap-3 px-5 py-4">
                  <span
                    aria-hidden="true"
                    className={cx('size-2.5 rounded-full', c.status === 'up' ? 'bg-emerald-500' : 'bg-red-500')}
                  />
                  <span className="font-medium text-slate-900">{LABELS[name] ?? name}</span>
                  <span className="text-sm text-slate-500">
                    {c.status}
                    {c.status === 'up' && ` (${c.latencyMs} ms)`}
                    {!c.required && c.status === 'down' && ' – optional, site keeps working'}
                  </span>
                  <span className="ml-auto">
                    <StatusBadge status={c.status} />
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </Container>
  );
}