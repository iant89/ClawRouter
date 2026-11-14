import { useEffect, useState } from 'react';
import { MessageStrip, Pagination, StatusIndicator, Table, Text, type TableColumn } from '@enterprise-ui/react';
import type { ApiKeyInfo } from '@clawrouter/shared';
import { formatRelative } from '../../services/format.ts';
import { fetchKeysBeyondLifetime } from '../../services/gateway.ts';

const PAGE_SIZE = 10;

const columns: TableColumn<ApiKeyInfo>[] = [
  { id: 'key', header: 'Key', rowHeader: true, accessor: 'name', cell: (k) => <span>{k.name} <Text size="sm" tone="secondary" className="claw-mono">{k.prefix}…</Text></span> },
  { id: 'owner', header: 'Owner', accessor: (k) => k.createdBy?.username ?? '', cell: (k) => (k.createdBy ? k.createdBy.username : <Text tone="secondary">(deleted user)</Text>) },
  {
    id: 'expires', header: 'Expires', accessor: (k) => k.expiresAt ?? '',
    cell: (k) => (k.expiresAt
      ? <span title={new Date(k.expiresAt).toLocaleString()}>{new Date(k.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
      : <StatusIndicator tone="warning" size="sm" icon="warning">Never</StatusIndicator>),
  },
  { id: 'created', header: 'Created', accessor: 'createdAt', cell: (k) => <span title={new Date(k.createdAt).toLocaleString()}>{formatRelative(k.createdAt)}</span> },
];

/**
 * Settings → API keys: active keys of non-administrators that last longer than the
 * maximum key lifetime. Changing the limit does not shorten existing keys, so an
 * administrator lowering it sees which keys (and whose) still outlast it, and can
 * revoke them in API Access. `days` is the value being typed (or the saved one).
 */
export function KeysBeyondLifetime({ days, lowering }: { days: number; lowering: boolean }) {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{ days: number; items: ApiKeyInfo[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setPage(1), [days]);
  useEffect(() => {
    const controller = new AbortController();
    // Wait until typing pauses before asking the server.
    const timer = setTimeout(() => {
      fetchKeysBeyondLifetime(days, page, PAGE_SIZE, controller.signal)
        .then((r) => { setResult({ days, items: r.items, total: r.total }); setError(null); })
        .catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load the keys.'); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [days, page]);

  if (error) return <MessageStrip tone="error" title="Cannot list keys beyond the limit">{error}</MessageStrip>;
  if (!result) return null;
  const unit = `${result.days} day${result.days === 1 ? '' : 's'}`;
  if (!result.total) {
    return lowering ? <Text size="sm" tone="secondary" role="status">No active key outlasts {unit}: lowering the limit affects new keys only.</Text> : null;
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--eui-space-2, 0.5rem)' }}>
      <MessageStrip tone="warning" title={lowering ? `${result.total} active key${result.total === 1 ? '' : 's'} would outlast ${unit}` : `${result.total} active key${result.total === 1 ? '' : 's'} outlast the limit`}>
        The limit applies to new keys only; these keep working until they expire. Revoke any that should stop sooner in API Access.
      </MessageStrip>
      <Table
        caption={`Active keys lasting longer than ${unit}`}
        columns={columns}
        data={result.items}
        getRowId={(k) => k.id}
        getRowLabel={(k) => k.name}
      />
      {result.total > PAGE_SIZE && <Pagination page={page} onPageChange={setPage} totalItems={result.total} pageSize={PAGE_SIZE} />}
    </div>
  );
}
