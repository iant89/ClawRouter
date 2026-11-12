import { MessageStrip, Page, RefreshControl, Table, Text, type TableColumn } from '@enterprise-ui/react';
import type { HealthCheckResult } from '@clawapi/shared';
import { HealthStateIndicator } from '../../components/custom/HealthStateIndicator.tsx';
import { componentLabel, formatTime } from '../../services/format.ts';
import { useHealth } from './HealthContext.tsx';

const columns: TableColumn<HealthCheckResult>[] = [
  { id: 'component', header: 'Component', rowHeader: true, accessor: (r) => componentLabel(r.component), sortable: true },
  { id: 'status', header: 'Status', accessor: 'status', cell: (r) => <HealthStateIndicator state={r.status} size="sm" />, sortable: true },
  { id: 'critical', header: 'Critical', accessor: (r) => (r.critical ? 'Yes' : 'No') },
  { id: 'latency', header: 'Latency', align: 'end', accessor: 'latencyMs', cell: (r) => <span className="claw-mono">{r.latencyMs} ms</span>, sortable: true },
  { id: 'detail', header: 'Detail', accessor: (r) => r.detail ?? '—', wrap: true },
  { id: 'checked', header: 'Checked', accessor: (r) => formatTime(r.checkedAt) },
];

export function HealthPage() {
  const { data, error, loading, lastUpdated, refresh } = useHealth();
  return (
    <Page
      title="Health"
      subtitle="Status of each platform component, checked by the server"
      titleAddon={data ? <HealthStateIndicator state={data.status} /> : undefined}
      actions={<RefreshControl onRefresh={refresh} refreshing={loading} lastUpdated={lastUpdated} intervals={[]} />}
    >
      {error && (
        <MessageStrip tone="error" title="Health check unavailable">
          {error.message}
        </MessageStrip>
      )}
      <Table
        caption="Component health"
        columns={columns}
        data={data?.checks ?? []}
        getRowId={(r) => r.component}
        loading={loading && !data}
        emptyState={<Text>No health checks reported.</Text>}
      />
      <Text as="p" size="sm" tone="secondary">
        Gateway, authentication, provider and WebSocket checks are added as those domains are implemented.
      </Text>
    </Page>
  );
}
