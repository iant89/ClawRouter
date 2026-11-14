import { useEffect, useState } from 'react';
import { AlertDialog, Button, MessageStrip, Pagination, StatusIndicator, Table, Text, useToast, type TableColumn } from '@enterprise-ui/react';
import type { ApiKeyInfo } from '@clawrouter/shared';
import { formatRelative } from '../../services/format.ts';
import { fetchKeysBeyondLifetime, revokeApiKey } from '../../services/gateway.ts';
import { usePermissions } from '../auth/AuthContext.tsx';

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
 * revoke them here (`api_keys.write`). `days` is the value being typed (or the saved one).
 */
export function KeysBeyondLifetime({ days, lowering }: { days: number; lowering: boolean }) {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{ days: number; items: ApiKeyInfo[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyInfo | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const canRevoke = usePermissions().can('api_keys.write');
  const toast = useToast();

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
  }, [days, page, reloadKey]);

  const confirmRevoke = async () => {
    const key = revoking;
    setRevoking(null);
    if (!key) return;
    try {
      await revokeApiKey(key.id);
      toast.show({ tone: 'success', title: 'API key revoked', description: ` (…) no longer works.` });
      // The last key of a page: go back one page.
      if (result && result.items.length === 1 && page > 1) setPage(page - 1);
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast.show({ tone: 'error', title: 'Could not revoke the key', description: err instanceof Error ? err.message : undefined, duration: 10_000 });
    }
  };

  if (error) return <MessageStrip tone="error" title="Cannot list keys beyond the limit">{error}</MessageStrip>;
  if (!result) return null;
  const unit = `${result.days} day${result.days === 1 ? '' : 's'}`;
  if (!result.total) {
    return lowering ? <Text as="p" size="sm" tone="secondary" role="status" style={{ marginTop: 'var(--eui-space-3, 0.75rem)' }}>No active key outlasts {unit}: lowering the limit affects new keys only.</Text> : null;
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--eui-space-2, 0.5rem)', marginTop: 'var(--eui-space-4, 1rem)' }}>
      <MessageStrip tone="warning" title={lowering ? `${result.total} active key${result.total === 1 ? '' : 's'} would outlast ${unit}` : `${result.total} active key${result.total === 1 ? '' : 's'} outlast the limit`}>
        The limit applies to new keys only; these keep working until they expire or are revoked.
      </MessageStrip>
      <Table
        caption={`Active keys lasting longer than ${unit}`}
        columns={canRevoke ? [...columns, {
          id: 'actions', header: 'Actions', align: 'end',
          cell: (k: ApiKeyInfo) => <Button size="sm" variant="tertiary" onClick={() => setRevoking(k)} aria-label={`Revoke ${k.name}`}>Revoke</Button>,
        }] : columns}
        data={result.items}
        getRowId={(k) => k.id}
        getRowLabel={(k) => k.name}
      />
      {result.total > PAGE_SIZE && <Pagination page={page} onPageChange={setPage} totalItems={result.total} pageSize={PAGE_SIZE} />}
      <AlertDialog open={revoking !== null} tone="warning" title="Revoke this API key?" confirmLabel="Revoke" onCancel={() => setRevoking(null)} onConfirm={confirmRevoke}>
        {revoking && `Applications using "${revoking.name}" (${revoking.prefix}…), owned by ${revoking.createdBy?.username ?? 'a deleted user'}, will get 401 errors immediately. This cannot be undone.`}
      </AlertDialog>
    </div>
  );
}
