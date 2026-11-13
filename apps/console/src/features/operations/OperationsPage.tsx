import { useCallback, useEffect, useState } from 'react';
import {
  AlertDialog, Button, MessageStrip, OverflowMenu, Page, Pagination, RefreshControl, Select, StatusIndicator, Table, Text, useToast, type TableColumn,
} from '@enterprise-ui/react';
import { FINAL_OPERATION_STATUSES, OPERATION_STATUSES, OPERATION_TYPES, type OperationInfo, type OperationStatus, type OperationType } from '@clawrouter/shared';
import type { PagedResult } from '../../services/api-client.ts';
import { cancelOperation, fetchOperations, startOperation } from '../../services/operations.ts';
import { formatDuration, formatRelative } from '../../services/format.ts';
import { usePermissions } from '../auth/AuthContext.tsx';
import { useRealtimeEvent } from '../realtime/RealtimeContext.tsx';

const PAGE_SIZE = 50;

export const OPERATION_STATUS: Record<OperationStatus, { tone: 'success' | 'warning' | 'error' | 'information' | 'neutral'; label: string }> = {
  QUEUED: { tone: 'neutral', label: 'Queued' },
  RUNNING: { tone: 'information', label: 'Running' },
  SUCCESS: { tone: 'success', label: 'Succeeded' },
  FAILED: { tone: 'error', label: 'Failed' },
  TIMEOUT: { tone: 'error', label: 'Timed out' },
  CANCELLED: { tone: 'neutral', label: 'Cancelled' },
};

const isFinal = (s: OperationStatus) => (FINAL_OPERATION_STATUSES as readonly string[]).includes(s);
const durationOf = (o: OperationInfo) => (o.startedAt ? (o.completedAt ? Date.parse(o.completedAt) : Date.now()) - Date.parse(o.startedAt) : null);

/** System → Operations: long-running work with live progress and cancellation (spec §26). */
export function OperationsPage() {
  const toast = useToast();
  const perms = usePermissions();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<OperationStatus | null>(null);
  const [result, setResult] = useState<PagedResult<OperationInfo> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date>();
  const [reloadKey, setReloadKey] = useState(0);
  const [cancelling, setCancelling] = useState<OperationInfo | null>(null);
  const [starting, setStarting] = useState<OperationType | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetchOperations({ page, pageSize: PAGE_SIZE, status: status ?? undefined }, controller.signal)
      .then((r) => { setResult(r); setError(null); setLastUpdated(new Date()); })
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load operations.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, status, reloadKey]);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  useRealtimeEvent('operation.progress', reload, 300);

  const canRun = (type: OperationType) => perms.can(OPERATION_TYPES[type].run);

  const start = async (type: OperationType) => {
    setStarting(type);
    try {
      await startOperation(type);
      reload();
    } catch (err) {
      toast.show({ tone: 'error', title: `Could not start "${OPERATION_TYPES[type].label}"`, description: err instanceof Error ? err.message : undefined, duration: 10_000 });
    } finally {
      setStarting(null);
    }
  };

  const confirmCancel = async () => {
    if (!cancelling) return;
    try {
      await cancelOperation(cancelling.id);
      toast.show({ tone: 'success', title: 'Operation cancelled', description: OPERATION_TYPES[cancelling.type].label });
      reload();
    } catch (err) {
      toast.show({ tone: 'error', title: 'Could not cancel', description: err instanceof Error ? err.message : undefined, duration: 10_000 });
    } finally {
      setCancelling(null);
    }
  };

  const columns: TableColumn<OperationInfo>[] = [
    { id: 'created', header: 'Started', accessor: 'createdAt', cell: (o) => <span title={new Date(o.createdAt).toLocaleString()}>{formatRelative(o.createdAt)}</span> },
    {
      id: 'type', header: 'Operation', rowHeader: true, wrap: true, accessor: (o) => OPERATION_TYPES[o.type].label,
      cell: (o) => <span>{OPERATION_TYPES[o.type].label}{o.targetLabel && <><br /><Text size="sm" tone="secondary">{o.targetLabel}</Text></>}</span>,
    },
    {
      id: 'status', header: 'Status', accessor: 'status',
      cell: (o) => (
        <StatusIndicator tone={OPERATION_STATUS[o.status].tone} size="sm">
          {OPERATION_STATUS[o.status].label}{o.status === 'RUNNING' ? ` · ${o.progress}%` : ''}
        </StatusIndicator>
      ),
    },
    { id: 'message', header: 'Details', wrap: true, accessor: (o) => o.error ?? o.message ?? '', cell: (o) => (o.status === 'FAILED' || o.status === 'TIMEOUT' ? o.error ?? o.message : o.message) ?? '—' },
    { id: 'by', header: 'By', accessor: (o) => o.createdBy?.username ?? '', cell: (o) => o.createdBy?.username ?? '—' },
    { id: 'duration', header: 'Duration', align: 'end', accessor: (o) => durationOf(o) ?? -1, cell: (o) => formatDuration(durationOf(o)) },
    {
      id: 'actions', header: 'Actions', align: 'end',
      cell: (o) => (!isFinal(o.status) && canRun(o.type)
        ? <OverflowMenu label={`Actions for ${OPERATION_TYPES[o.type].label}`} items={[{ id: 'cancel', label: 'Cancel', destructive: true }]} onAction={() => setCancelling(o)} />
        : null),
    },
  ];

  const total = result?.total ?? 0;
  return (
    <Page
      title="Operations"
      subtitle="Long-running work: connection tests, provider checks and health checks"
      actions={
        <>
          <RefreshControl onRefresh={reload} refreshing={loading} lastUpdated={lastUpdated} intervals={[]} />
          {canRun('health.check') && <Button variant="secondary" loading={starting === 'health.check'} onClick={() => start('health.check')}>Run health checks</Button>}
          {canRun('providers.check') && <Button variant="primary" loading={starting === 'providers.check'} onClick={() => start('providers.check')}>Check all providers</Button>}
        </>
      }
    >
      {error && <MessageStrip tone="error" title="Cannot load operations">{error}</MessageStrip>}
      <div style={{ maxWidth: '16rem' }}>
        <Select label="Status" value={status ?? 'any'} onChange={(v) => { setStatus(v === 'any' || !v ? null : (v as OperationStatus)); setPage(1); }}
          options={[{ value: 'any', label: 'Any status' }, ...OPERATION_STATUSES.map((s) => ({ value: s, label: OPERATION_STATUS[s].label }))]} />
      </div>
      <Table
        caption={`Operations (${total.toLocaleString()})`}
        columns={columns}
        data={result?.items ?? []}
        getRowId={(o) => o.id}
        getRowLabel={(o) => `${OPERATION_TYPES[o.type].label}, ${OPERATION_STATUS[o.status].label}`}
        loading={loading && !result}
        emptyState="No operations yet. Connection tests and checks you start appear here."
      />
      {total > PAGE_SIZE && <Pagination page={page} onPageChange={setPage} totalItems={total} pageSize={PAGE_SIZE} />}
      <Text size="sm" tone="secondary">Operations run two at a time; others wait in the queue. Cancelling stops waiting for the work at once. Kept for 30 days.</Text>

      <AlertDialog open={cancelling !== null} tone="warning" title="Cancel this operation?" confirmLabel="Cancel operation" cancelLabel="Keep running"
        onCancel={() => setCancelling(null)} onConfirm={confirmCancel}>
        {cancelling && `${OPERATION_TYPES[cancelling.type].label}${cancelling.targetLabel ? ` (${cancelling.targetLabel})` : ''} will stop. Work already sent to a provider may still finish there.`}
      </AlertDialog>
    </Page>
  );
}
