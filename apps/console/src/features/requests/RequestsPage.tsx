import { useCallback, useEffect, useState } from 'react';
import {
  Input, MessageStrip, Page, Pagination, RefreshControl, SegmentedButton, Select, StatusIndicator, Switch, Table, Text, type TableColumn,
} from '@enterprise-ui/react';
import { REQUEST_STATUSES, type ApiKeyInfo, type RequestRecord, type RequestStatus } from '@clawrouter/shared';
import type { PagedResult } from '../../services/api-client.ts';
import { fetchApiKeys } from '../../services/gateway.ts';
import { fetchRequests } from '../../services/requests.ts';
import { formatDuration, formatRelative, formatUsd } from '../../services/format.ts';
import { usePermissions } from '../auth/AuthContext.tsx';
import { describeAttempts, describeTokens, STATUS } from './request-format.ts';
import { RequestDetailDialog } from './RequestDetailDialog.tsx';
import { useActivity, useLive } from '../realtime/RealtimeContext.tsx';

const PAGE_SIZE = 50;
const PERIODS = [
  { value: '1h', label: '1 hour', ms: 3_600_000 },
  { value: '24h', label: '24 hours', ms: 86_400_000 },
  { value: '7d', label: '7 days', ms: 7 * 86_400_000 },
  { value: 'all', label: 'All', ms: null },
] as const;
type Period = (typeof PERIODS)[number]['value'];

/** Gateway → Requests: every gateway request with its routing outcome (spec §22). Filtered and paged on the server. */
export function RequestsPage() {
  const canKeys = usePermissions().can('api_keys.read');
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<RequestStatus | null>(null);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [apiKeyId, setApiKeyId] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState('');
  const [model, setModel] = useState('');
  const [period, setPeriod] = useState<Period>('24h');
  const [result, setResult] = useState<PagedResult<RequestRecord> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date>();
  const [reloadKey, setReloadKey] = useState(0);
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!canKeys) return;
    const controller = new AbortController();
    fetchApiKeys(controller.signal).then(setKeys).catch(() => {});
    return () => controller.abort();
  }, [canKeys]);

  useEffect(() => {
    const controller = new AbortController();
    const ms = PERIODS.find((p) => p.value === period)!.ms;
    setLoading(true);
    fetchRequests({
      page, pageSize: PAGE_SIZE, status: status ?? undefined, problemsOnly, apiKeyId: apiKeyId ?? undefined, model: model || undefined,
      from: ms ? new Date(Date.now() - ms).toISOString() : undefined,
    }, controller.signal)
      .then((next) => { setResult(next); setError(null); setLastUpdated(new Date()); })
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load requests.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, status, problemsOnly, apiKeyId, model, period, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const live = useLive();
  const [follow, setFollow] = useState(true);
  // New requests appear as they happen, on the first page only (other pages would shift under the reader).
  useActivity(() => { if (follow && page === 1) reload(); }, 2000);
  /** Any filter change starts again at page 1. */
  const filter = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  const columns: TableColumn<RequestRecord>[] = [
    { id: 'time', header: 'Received', accessor: 'receivedAt', cell: (r) => <span title={new Date(r.receivedAt).toLocaleString()}>{formatRelative(r.receivedAt)}</span> },
    { id: 'status', header: 'Status', accessor: 'status', cell: (r) => <StatusIndicator tone={STATUS[r.status].tone} size="sm">{STATUS[r.status].label}</StatusIndicator> },
    {
      id: 'model', header: 'Model', rowHeader: true, wrap: true, accessor: (r) => r.modelRef ?? r.requestedModel,
      cell: (r) => (
        <span className="claw-mono">
          {r.requestedModel || '—'}
          {r.modelRef && r.modelRef !== r.requestedModel && <><br /><Text size="sm" tone="secondary">→ {r.modelRef}</Text></>}
        </span>
      ),
    },
    { id: 'key', header: 'API key', wrap: true, accessor: (r) => r.apiKey?.name ?? '', cell: (r) => r.apiKey?.name ?? '—' },
    {
      id: 'result', header: 'Result', wrap: true, accessor: (r) => r.errorCode ?? '',
      cell: (r) => (r.errorCode ? <span title={r.errorMessage ?? undefined}><span className="claw-mono">{r.httpStatus}</span> {r.errorCode}</span> : r.httpStatus ? <span className="claw-mono">{r.httpStatus}</span> : '—'),
    },
    { id: 'attempts', header: 'Attempts', accessor: 'attempts', cell: (r) => describeAttempts(r) },
    { id: 'duration', header: 'Duration', align: 'end', accessor: (r) => r.durationMs ?? -1, cell: (r) => formatDuration(r.durationMs) },
    { id: 'tokens', header: 'Tokens', align: 'end', wrap: true, accessor: (r) => (r.inputTokens ?? 0) + (r.outputTokens ?? 0), cell: (r) => describeTokens(r) },
    { id: 'cost', header: 'Est. cost', align: 'end', accessor: (r) => r.costUsd ?? -1, cell: (r) => <span className="claw-mono">{formatUsd(r.costUsd)}</span> },
  ];

  const total = result?.total ?? 0;
  return (
    <Page
      title="Requests"
      subtitle="Every gateway request, how it was routed and how it ended"
      actions={<RefreshControl onRefresh={reload} refreshing={loading} lastUpdated={lastUpdated} intervals={[]} />}
    >
      {error && <MessageStrip tone="error" title="Cannot load requests">{error}</MessageStrip>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))', gap: 'var(--eui-space-3, 0.75rem)', alignItems: 'end' }}>
        <Select label="Status" value={status ?? 'any'} onChange={(v) => filter(setStatus)(v === 'any' || !v ? null : (v as RequestStatus))}
          options={[{ value: 'any', label: 'Any status' }, ...REQUEST_STATUSES.map((s) => ({ value: s, label: STATUS[s].label }))]} />
        {canKeys && (
          <Select label="API key" value={apiKeyId ?? 'any'} onChange={(v) => filter(setApiKeyId)(v === 'any' || !v ? null : v)}
            options={[{ value: 'any', label: 'Any key' }, ...keys.map((k) => ({ value: k.id, label: k.name, description: `${k.prefix}…` }))]} />
        )}
        <Input label="Model" placeholder="Alias or provider/model" className="claw-mono" value={modelDraft}
          description="Press Enter to apply."
          onChange={(e) => setModelDraft(e.target.value)}
          onBlur={() => filter(setModel)(modelDraft.trim())}
          onKeyDown={(e) => { if (e.key === 'Enter') filter(setModel)(modelDraft.trim()); }} />
        <Switch label="Problems only" checked={problemsOnly} onChange={filter(setProblemsOnly)} />
        <Switch label="Show new requests as they arrive" checked={follow && live} disabled={!live} onChange={setFollow}
          description={live ? (page === 1 ? undefined : 'Only on the first page.') : 'Needs the live connection.'} />
      </div>
      <SegmentedButton aria-label="Period" size="sm" selectionMode="single" value={[period]}
        onChange={(v) => v[0] && filter(setPeriod)(v[0] as Period)} items={PERIODS.map((p) => ({ value: p.value, label: p.label }))} />

      <Table
        caption={`Requests (${total.toLocaleString()})`}
        columns={columns}
        data={result?.items ?? []}
        getRowId={(r) => r.id}
        getRowLabel={(r) => `${r.requestedModel} at ${new Date(r.receivedAt).toLocaleTimeString()}, ${STATUS[r.status].label}`}
        onRowClick={(r) => setSelected(r.id)}
        loading={loading && !result}
        emptyState="No requests match these filters."
      />
      {total > PAGE_SIZE && <Pagination page={page} onPageChange={setPage} totalItems={total} pageSize={PAGE_SIZE} />}
      <Text size="sm" tone="secondary">Select a request for its attempts. Only metadata is kept, never prompts or answers. Tokens marked ≈ were estimated locally.</Text>

      <RequestDetailDialog id={selected} onClose={() => setSelected(null)} />
    </Page>
  );
}
