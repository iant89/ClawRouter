import { useCallback, useEffect, useState } from 'react';
import {
  Button, DescriptionList, Dialog, Input, MessageStrip, Page, Pagination, RefreshControl, SegmentedButton, Select, StatusIndicator, Table, Text,
  type TableColumn,
} from '@enterprise-ui/react';
import { AUDIT_ACTIONS, type AuditAction, type AuditRecord, type AuditResult } from '@clawrouter/shared';
import { useRouter } from '../../app/router.tsx';
import { auditActionLabel, fetchAudit, type AuditPage as AuditResultPage } from '../../services/audit.ts';
import { formatRelative } from '../../services/format.ts';
import { usePermissions } from '../auth/AuthContext.tsx';

const PAGE_SIZE = 50;
const PERIODS = [
  { value: '24h', label: '24 hours', ms: 86_400_000 },
  { value: '7d', label: '7 days', ms: 7 * 86_400_000 },
  { value: '30d', label: '30 days', ms: 30 * 86_400_000 },
  { value: 'all', label: 'All', ms: null },
] as const;
type Period = (typeof PERIODS)[number]['value'];

const when = (iso: string) => new Date(iso).toLocaleString();

/**
 * System → Audit: who did what, when and from where (spec §28), filtered and
 * paged on the server. Metadata was redacted when it was written.
 */
export function AuditPage() {
  const { search, navigate } = useRouter();
  const canLogs = usePermissions().can('logs.read');
  const initial = new URLSearchParams(search);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<AuditAction | null>((initial.get('action') as AuditAction | null) ?? null);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [resource, setResource] = useState<string | null>(initial.get('resource'));
  const [period, setPeriod] = useState<Period>('7d');
  const [textDraft, setTextDraft] = useState(initial.get('q') ?? '');
  const [text, setText] = useState(initial.get('q') ?? '');
  const [actorDraft, setActorDraft] = useState('');
  const [actor, setActor] = useState('');
  const requestId = initial.get('requestId') ?? '';
  const [data, setData] = useState<AuditResultPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date>();
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState<AuditRecord | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const ms = PERIODS.find((p) => p.value === period)!.ms;
    setLoading(true);
    fetchAudit({
      page, pageSize: PAGE_SIZE, action: action ?? undefined, result: result ?? undefined, resource: resource ?? undefined,
      actor: actor || undefined, q: text || undefined, requestId: requestId || undefined,
      from: ms ? new Date(Date.now() - ms).toISOString() : undefined,
    }, controller.signal)
      .then((r) => { setData(r); setError(null); setLastUpdated(new Date()); })
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load the audit log.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, action, result, resource, period, text, actor, requestId, reloadKey]);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const filter = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  const columns: TableColumn<AuditRecord>[] = [
    { id: 'time', header: 'When', accessor: 'timestamp', cell: (r) => <span title={when(r.timestamp)}>{formatRelative(r.timestamp)}</span> },
    { id: 'action', header: 'Action', rowHeader: true, accessor: 'action', cell: (r) => auditActionLabel(r.action) },
    {
      id: 'result', header: 'Result', accessor: 'result',
      cell: (r) => <StatusIndicator tone={r.result === 'SUCCESS' ? 'success' : 'error'} size="sm">{r.result === 'SUCCESS' ? 'Succeeded' : 'Failed'}</StatusIndicator>,
    },
    { id: 'actor', header: 'By', accessor: (r) => r.actorName ?? '', cell: (r) => r.actorName ?? <Text tone="secondary">—</Text> },
    {
      id: 'resource', header: 'Resource', wrap: true, accessor: (r) => r.resource ?? '',
      cell: (r) => (r.resource ? <span>{r.resource}{r.resourceId && <><br /><Text size="sm" tone="secondary" className="claw-mono">{r.resourceId.length > 20 ? `${r.resourceId.slice(0, 18)}…` : r.resourceId}</Text></>}</span> : '—'),
    },
    { id: 'ip', header: 'Address', accessor: (r) => r.ip ?? '', cell: (r) => <span className="claw-mono">{r.ip ?? '—'}</span> },
  ];

  const total = data?.total ?? 0;
  return (
    <Page
      title="Audit"
      subtitle="Who did what, when and from where"
      actions={<RefreshControl onRefresh={reload} refreshing={loading} lastUpdated={lastUpdated} intervals={[]} />}
    >
      {error && <MessageStrip tone="error" title="Cannot load the audit log">{error}</MessageStrip>}
      {requestId && (
        <MessageStrip tone="information" title="Showing one request">
          Records for request <span className="claw-mono">{requestId}</span>. <Button size="sm" variant="tertiary" onClick={() => navigate('/audit', { replace: true })}>Show all</Button>
        </MessageStrip>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))', gap: 'var(--eui-space-3, 0.75rem)', alignItems: 'end' }}>
        <Select label="Action" value={action ?? 'any'} onChange={(v) => filter(setAction)(v === 'any' || !v ? null : (v as AuditAction))}
          options={[{ value: 'any', label: 'Any action' }, ...AUDIT_ACTIONS.map((a) => ({ value: a, label: auditActionLabel(a) }))]} />
        <Select label="Result" value={result ?? 'any'} onChange={(v) => filter(setResult)(v === 'any' || !v ? null : (v as AuditResult))}
          options={[{ value: 'any', label: 'Any result' }, { value: 'SUCCESS', label: 'Succeeded' }, { value: 'FAILURE', label: 'Failed' }]} />
        <Select label="Resource" value={resource ?? 'any'} onChange={(v) => filter(setResource)(v === 'any' || !v ? null : v)}
          options={[{ value: 'any', label: 'Any resource' }, ...(data?.resources ?? []).map((r) => ({ value: r, label: r }))]} />
        <Input label="By" value={actorDraft} placeholder="Username" onChange={(e) => setActorDraft(e.target.value)}
          onBlur={() => filter(setActor)(actorDraft.trim())} onKeyDown={(e) => { if (e.key === 'Enter') filter(setActor)(actorDraft.trim()); }} />
        <Input label="Search" value={textDraft} placeholder="Id, address or details" description="Press Enter to apply."
          onChange={(e) => setTextDraft(e.target.value)} onBlur={() => filter(setText)(textDraft.trim())} onKeyDown={(e) => { if (e.key === 'Enter') filter(setText)(textDraft.trim()); }} />
      </div>
      <SegmentedButton aria-label="Period" size="sm" selectionMode="single" value={[period]} onChange={(v) => v[0] && filter(setPeriod)(v[0] as Period)}
        items={PERIODS.map((p) => ({ value: p.value, label: p.label }))} />

      <Table
        caption={`Audit records (${total.toLocaleString()})`}
        columns={columns}
        data={data?.items ?? []}
        getRowId={(r) => r.id}
        getRowLabel={(r) => `${auditActionLabel(r.action)} by ${r.actorName ?? 'unknown'}`}
        onRowClick={setSelected}
        loading={loading && !data}
        emptyState="No audit records match these filters."
      />
      {total > PAGE_SIZE && <Pagination page={page} onPageChange={setPage} totalItems={total} pageSize={PAGE_SIZE} />}
      <Text size="sm" tone="secondary">The audit log is append-only: records cannot be changed or deleted from the console. Details never contain secrets.</Text>

      <Dialog open={selected !== null} onClose={() => setSelected(null)} size="lg" title={selected ? auditActionLabel(selected.action) : 'Audit record'}
        footer={<Button variant="primary" onClick={() => setSelected(null)}>Close</Button>}>
        {selected && (
          <>
            <DescriptionList
              columns={2}
              items={[
                { term: 'When', description: when(selected.timestamp) },
                { term: 'Result', description: <StatusIndicator tone={selected.result === 'SUCCESS' ? 'success' : 'error'} size="sm">{selected.result === 'SUCCESS' ? 'Succeeded' : 'Failed'}</StatusIndicator> },
                { term: 'By', description: selected.actorName ?? '—' },
                { term: 'Address', description: <span className="claw-mono">{selected.ip ?? '—'}</span> },
                { term: 'Resource', description: selected.resource ?? '—' },
                { term: 'Resource ID', description: <span className="claw-mono claw-break">{selected.resourceId ?? '—'}</span> },
                {
                  term: 'Request',
                  description: selected.requestId
                    ? (canLogs
                      ? <Button size="sm" variant="tertiary" onClick={() => navigate(`/logs?requestId=${encodeURIComponent(selected.requestId!)}`)}><span className="claw-mono">{selected.requestId}</span> (logs)</Button>
                      : <span className="claw-mono">{selected.requestId}</span>)
                    : '—',
                },
              ]}
            />
            <Text as="strong">Details</Text>
            <pre className="claw-mono claw-code">{selected.metadata ? JSON.stringify(selected.metadata, null, 2) : 'None'}</pre>
          </>
        )}
      </Dialog>
    </Page>
  );
}
