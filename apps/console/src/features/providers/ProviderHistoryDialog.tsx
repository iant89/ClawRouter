import { useEffect, useState } from 'react';
import { Button, DescriptionList, Dialog, MessageStrip, Table, Text, type TableColumn } from '@enterprise-ui/react';
import type { ProviderCheck, ProviderDetail, ProviderInfo } from '@clawapi/shared';
import { ProviderStatus } from '../../components/custom/ProviderStatus.tsx';
import { fetchProvider } from '../../services/providers.ts';

const columns: TableColumn<ProviderCheck>[] = [
  { id: 'when', header: 'Checked', rowHeader: true, accessor: (c) => new Date(c.checkedAt).toLocaleString() },
  { id: 'kind', header: 'Type', accessor: (c) => (c.kind === 'TEST' ? 'Connection test' : 'Health check') },
  { id: 'status', header: 'Result', accessor: 'status', cell: (c) => <ProviderStatus state={c.status} size="sm" /> },
  { id: 'latency', header: 'Latency', align: 'end', accessor: (c) => c.latencyMs ?? -1, cell: (c) => <span className="claw-mono">{c.latencyMs === null ? '—' : `${c.latencyMs} ms`}</span> },
  { id: 'detail', header: 'Detail', wrap: true, accessor: (c) => c.detail ?? '' },
];

/** Provider details and recent checks (kept 7 days). */
export function ProviderHistoryDialog({ provider, onClose }: { provider: ProviderInfo | null; onClose: () => void }) {
  const [detail, setDetail] = useState<ProviderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    if (!provider) return;
    const controller = new AbortController();
    fetchProvider(provider.id, controller.signal).then(setDetail).catch((err: unknown) => {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load details.');
    });
    return () => controller.abort();
  }, [provider]);

  return (
    <Dialog open={provider !== null} onClose={onClose} size="lg" title={provider ? provider.name : 'Provider'} footer={<Button onClick={onClose}>Close</Button>}>
      {error && <MessageStrip tone="error">{error}</MessageStrip>}
      {detail && (
        <div style={{ display: 'grid', gap: 'var(--eui-space-4, 1rem)' }}>
          <DescriptionList
            columns={2}
            items={[
              { term: 'Identifier', description: <span className="claw-mono">{detail.identifier}</span> },
              { term: 'Status', description: <><ProviderStatus state={detail.status} size="sm" /> {detail.statusDetail}</> },
              { term: 'Endpoint', description: <span className="claw-mono claw-break">{detail.endpoint}</span>, span: 'full' },
              { term: 'Capabilities', description: detail.capabilities.join(', ') || '—' },
              { term: 'API key', description: detail.credential.configured ? `Stored${detail.credential.hint ? `, ends in ${detail.credential.hint}` : ''}` : 'Not set' },
            ]}
          />
          <Table caption="Recent checks" columns={columns} data={detail.recentChecks} getRowId={(c) => `${c.checkedAt}-${c.kind}`} emptyState={<Text>No checks yet. Run a connection test.</Text>} />
        </div>
      )}
    </Dialog>
  );
}
