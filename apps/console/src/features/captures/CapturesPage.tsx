import { useCallback, useEffect, useState } from 'react';
import {
  AlertDialog, Button, MessageStrip, Page, Pagination, RefreshControl, Select, StatusIndicator, Table, Text, useToast, type TableColumn,
} from '@enterprise-ui/react';
import { CAPTURE_TRIGGER_LABELS, CAPTURE_TRIGGERS, type CaptureState, type CaptureSummary, type CaptureTrigger, type ProviderInfo } from '@clawrouter/shared';
import type { PagedResult } from '../../services/api-client.ts';
import { deleteCaptures, fetchCaptures, fetchCaptureState, stopManualCapture } from '../../services/captures.ts';
import { fetchProviders } from '../../services/providers.ts';
import { formatRelative } from '../../services/format.ts';
import { useRouter } from '../../app/router.tsx';
import { usePermissions } from '../auth/AuthContext.tsx';
import { useActivity } from '../realtime/RealtimeContext.tsx';
import { CaptureDetailDialog } from './CaptureDetailDialog.tsx';
import { ExportCapturesDialog } from './ExportCapturesDialog.tsx';
import { ManualCaptureDialog } from './ManualCaptureDialog.tsx';
import { formatBytes, TRIGGER_TONE } from './capture-format.ts';

const PAGE_SIZE = 50;

/**
 * System → Captures (owner request, 2026-11-17): the full exchange of gateway
 * requests that went wrong with a provider, kept to export to a developer.
 */
export function CapturesPage() {
  const toast = useToast();
  const { navigate } = useRouter();
  const canSettings = usePermissions().can('settings.read');
  const [state, setState] = useState<CaptureState | null>(null);
  const [result, setResult] = useState<PagedResult<CaptureSummary> | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [page, setPage] = useState(1);
  const [trigger, setTrigger] = useState<CaptureTrigger | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date>();
  const [reloadKey, setReloadKey] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState<string[] | 'all' | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchProviders(controller.signal).then(setProviders).catch(() => setProviders([]));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    Promise.all([
      fetchCaptureState(controller.signal),
      fetchCaptures({ page, pageSize: PAGE_SIZE, trigger: trigger ?? undefined, providerId: providerId ?? undefined }, controller.signal),
    ])
      .then(([s, r]) => {
        setState(s);
        setResult(r);
        setError(null);
        setLastUpdated(new Date());
        // Keep only selected captures that are still listed.
        setSelection((sel) => sel.filter((id) => r.items.some((c) => c.id === id)));
      })
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load captures.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, trigger, providerId, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  // New captures come with failed requests: refresh the first page when traffic arrives.
  useActivity(() => { if (page === 1) reload(); }, 3000);
  const filter = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  const stop = async () => {
    try {
      setState(await stopManualCapture());
      toast.show({ tone: 'success', title: 'Manual capture stopped' });
    } catch (err) {
      toast.show({ tone: 'error', title: 'Could not stop the capture', description: err instanceof Error ? err.message : undefined, duration: 10_000 });
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      const { deleted } = await deleteCaptures(deleting === 'all' ? { all: true } : { ids: deleting });
      toast.show({ tone: 'success', title: `${deleted} capture${deleted === 1 ? '' : 's'} deleted` });
      if (open && (deleting === 'all' || deleting.includes(open))) setOpen(null);
      setSelection([]);
      setDeleting(null);
      reload();
    } catch (err) {
      toast.show({ tone: 'error', title: 'Could not delete', description: err instanceof Error ? err.message : undefined, duration: 10_000 });
    }
  };

  const columns: TableColumn<CaptureSummary>[] = [
    { id: 'time', header: 'Captured', accessor: 'createdAt', cell: (c) => <span title={new Date(c.createdAt).toLocaleString()}>{formatRelative(c.createdAt)}</span> },
    { id: 'trigger', header: 'Why', accessor: 'trigger', cell: (c) => <StatusIndicator tone={TRIGGER_TONE[c.trigger]} size="sm">{CAPTURE_TRIGGER_LABELS[c.trigger]}</StatusIndicator> },
    {
      id: 'model', header: 'Model', rowHeader: true, wrap: true, accessor: (c) => c.modelRef ?? c.requestedModel,
      cell: (c) => (
        <span className="claw-mono">
          {c.requestedModel || '—'}
          {c.modelRef && c.modelRef !== c.requestedModel && <><br /><Text size="sm" tone="secondary">→ {c.modelRef}</Text></>}
        </span>
      ),
    },
    { id: 'provider', header: 'Provider', wrap: true, accessor: (c) => c.providerName ?? '', cell: (c) => c.providerName ?? '—' },
    {
      id: 'result', header: 'Result', wrap: true, accessor: (c) => c.outcome.errorCode ?? '',
      cell: (c) => (c.outcome.errorCode
        ? <span title={c.outcome.errorMessage ?? undefined}><span className="claw-mono">{c.outcome.httpStatus}</span> {c.outcome.errorCode}</span>
        : <span className="claw-mono">{c.outcome.httpStatus}</span>),
    },
    { id: 'calls', header: 'Provider calls', align: 'end', accessor: 'exchangeCount' },
    { id: 'size', header: 'Size', align: 'end', accessor: 'sizeBytes', cell: (c) => formatBytes(c.sizeBytes) },
  ];

  const total = result?.total ?? 0;
  const manual = state?.manual ?? null;
  return (
    <Page
      title="Captures"
      subtitle="Requests that went wrong with a provider, recorded in full to send to a developer"
      actions={<>
        <Button variant="secondary" icon="record" onClick={() => setStarting(true)} disabled={!state?.enabled || !!manual}>Capture next requests…</Button>
        <RefreshControl onRefresh={reload} refreshing={loading} lastUpdated={lastUpdated} intervals={[]} />
      </>}
    >
      {error && <MessageStrip tone="error" title="Cannot load captures">{error}</MessageStrip>}
      {state && !state.enabled && (
        <MessageStrip tone="information" title="Captures are off">
          Nothing is being recorded. Turn on <strong>Capture provider errors</strong> in Settings → Data retention to record failed requests.
          {canSettings && <> <Button size="sm" variant="tertiary" onClick={() => navigate('/settings?tab=retention')}>Open settings</Button></>}
        </MessageStrip>
      )}
      {state?.enabled && (
        <MessageStrip tone="information">
          Recording is on: a request is kept when a provider call fails or its reply cannot be read. {state.stored.toLocaleString()} of up to {state.maxCount.toLocaleString()} kept; beyond that the oldest are deleted.
        </MessageStrip>
      )}
      {manual && (
        <MessageStrip tone="warning" title="Manual capture running">
          Capturing {manual.remaining} more of {manual.total} request{manual.total === 1 ? '' : 's'}
          {manual.providerId ? ` to ${providers.find((p) => p.id === manual.providerId)?.name ?? 'one provider'}` : ''}
          {manual.model ? <> for <span className="claw-mono">{manual.model}</span></> : ''}, until {new Date(manual.expiresAt).toLocaleTimeString()} (started by {manual.startedBy}).
          {' '}<Button size="sm" variant="tertiary" onClick={() => void stop()}>Stop</Button>
        </MessageStrip>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))', gap: 'var(--eui-space-3, 0.75rem)', alignItems: 'end' }}>
        <Select label="Why" value={trigger ?? 'any'} onChange={(v) => filter(setTrigger)(v === 'any' || !v ? null : (v as CaptureTrigger))}
          options={[{ value: 'any', label: 'Any reason' }, ...CAPTURE_TRIGGERS.map((t) => ({ value: t, label: CAPTURE_TRIGGER_LABELS[t] }))]} />
        <Select label="Provider" value={providerId ?? 'any'} onChange={(v) => filter(setProviderId)(v === 'any' || !v ? null : v)}
          options={[{ value: 'any', label: 'Any provider' }, ...providers.map((p) => ({ value: p.id, label: p.name }))]} />
      </div>

      <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', flexWrap: 'wrap', alignItems: 'center' }}>
        <Button variant="primary" icon="download" disabled={!selection.length} onClick={() => setExporting(selection)}>
          Export{selection.length ? ` ${selection.length}` : ''}…
        </Button>
        <Button variant="secondary" icon="delete" disabled={!selection.length} onClick={() => setDeleting(selection)}>Delete</Button>
        <Button variant="tertiary" disabled={!total} onClick={() => setDeleting('all')}>Delete all</Button>
        {!selection.length && total > 0 && <Text size="sm" tone="secondary">Select captures to export or delete them.</Text>}
      </div>

      <Table
        caption={`Captures (${total.toLocaleString()})`}
        columns={columns}
        data={result?.items ?? []}
        getRowId={(c) => c.id}
        getRowLabel={(c) => `${c.requestedModel} at ${new Date(c.createdAt).toLocaleTimeString()}, ${CAPTURE_TRIGGER_LABELS[c.trigger]}`}
        selectionMode="multiple"
        selectedIds={selection}
        onSelectionChange={setSelection}
        onRowClick={(c) => setOpen(c.id)}
        loading={loading && !result}
        emptyState={state?.enabled ? 'No captures. Requests that fail at a provider will appear here.' : 'No captures.'}
      />
      {total > PAGE_SIZE && <Pagination page={page} onPageChange={setPage} totalItems={total} pageSize={PAGE_SIZE} />}
      <Text size="sm" tone="secondary">
        Captures hold users' prompts and replies as they were sent; API keys and other credentials are never recorded. They are kept until deleted.
      </Text>

      <CaptureDetailDialog id={open} onClose={() => setOpen(null)} onExport={(id) => setExporting([id])} onDelete={(id) => setDeleting([id])} />
      <ExportCapturesDialog ids={exporting} onClose={() => setExporting(null)} />
      <ManualCaptureDialog open={starting} onClose={() => setStarting(false)} onStarted={reload} />
      <AlertDialog
        open={deleting !== null} tone="warning" onCancel={() => setDeleting(null)} onConfirm={confirmDelete}
        title={deleting === 'all' ? 'Delete every capture?' : `Delete ${deleting?.length ?? 0} capture${deleting?.length === 1 ? '' : 's'}?`}
        confirmLabel="Delete"
      >
        {deleting === 'all' ? `All ${total.toLocaleString()} captures are deleted. This cannot be undone.` : 'This cannot be undone.'}
      </AlertDialog>
    </Page>
  );
}
