import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button, CopyButton, Dialog, Input, MessageStrip, Page, Select, StatusIndicator, Switch, Table, Text, type TableColumn,
} from '@enterprise-ui/react';
import { LOG_LEVEL_NAMES, type LogEntry, type LogLevelName, type LogPage } from '@clawrouter/shared';
import { useRouter } from '../../app/router.tsx';
import { fetchLogs } from '../../services/logs.ts';

const LEVEL: Record<LogLevelName, { tone: 'neutral' | 'information' | 'warning' | 'error'; label: string }> = {
  debug: { tone: 'neutral', label: 'Debug' },
  info: { tone: 'information', label: 'Info' },
  warn: { tone: 'warning', label: 'Warning' },
  error: { tone: 'error', label: 'Error' },
  fatal: { tone: 'error', label: 'Fatal' },
};
const FOLLOW_MS = 2000;
const PAGE = 200;

const time = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

/** A few fields worth seeing in the list; everything is in the detail. */
function summary(e: LogEntry): string {
  const f = e.fields;
  const parts: string[] = [];
  for (const k of ['method', 'path', 'status', 'durationMs', 'model', 'kind', 'error']) {
    const v = f[k];
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${typeof v === 'object' ? ((v as { message?: string }).message ?? JSON.stringify(v)) : String(v)}`);
  }
  return parts.join(' ');
}

interface Filters {
  level: LogLevelName | '';
  component: string;
  requestId: string;
  providerId: string;
  userId: string;
  q: string;
}

const fromSearch = (search: string): Filters => {
  const p = new URLSearchParams(search);
  const level = p.get('level');
  return {
    level: level && (LOG_LEVEL_NAMES as readonly string[]).includes(level) ? (level as LogLevelName) : '',
    component: p.get('component') ?? '', requestId: p.get('requestId') ?? '', providerId: p.get('providerId') ?? '', userId: p.get('userId') ?? '', q: p.get('q') ?? '',
  };
};

/**
 * System → Logs: the server's recent log records (spec §27), filtered on the
 * server. Records were redacted when written. Filters live in the address, so a
 * request id can be linked to from Requests and Audit.
 */
export function LogsPage() {
  const { search, navigate } = useRouter();
  const filters = fromSearch(search);
  const [draft, setDraft] = useState(filters);
  const [items, setItems] = useState<LogEntry[]>([]);
  const [page, setPage] = useState<LogPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [follow, setFollow] = useState(true);
  const [selected, setSelected] = useState<LogEntry | null>(null);
  const latest = useRef(0);
  const key = JSON.stringify(filters);

  const query = useCallback((extra: { before?: number; after?: number } = {}) => ({
    level: filters.level || undefined, component: filters.component || undefined, requestId: filters.requestId || undefined,
    providerId: filters.providerId || undefined, userId: filters.userId || undefined, q: filters.q || undefined, limit: PAGE, ...extra,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [key]);

  // A new filter: load the newest matching records.
  useEffect(() => {
    setDraft(filters);
    const controller = new AbortController();
    setLoading(true);
    fetchLogs(query(), controller.signal)
      .then((p) => { setPage(p); setItems(p.items); latest.current = p.latestSeq; setError(null); })
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load logs.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Follow: fetch only what is newer than what is shown.
  useEffect(() => {
    if (!follow) return;
    const id = window.setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const p = await fetchLogs(query({ after: latest.current }));
        latest.current = p.latestSeq;
        if (p.items.length) setItems((old) => [...p.items, ...old].slice(0, 2000));
      } catch {
        // the next tick tries again; errors show on the next filter change
      }
    }, FOLLOW_MS);
    return () => window.clearInterval(id);
  }, [follow, query]);

  const apply = (next: Filters) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    navigate(`/logs${p.size ? `?${p}` : ''}`, { replace: true });
  };

  const loadOlder = async () => {
    const last = items.at(-1);
    if (!last) return;
    const p = await fetchLogs(query({ before: last.seq }));
    setItems((old) => [...old, ...p.items]);
    setPage((old) => (old ? { ...old, hasOlder: p.hasOlder } : p));
  };

  const columns: TableColumn<LogEntry>[] = [
    { id: 'time', header: 'Time', accessor: 'seq', cell: (e) => <span className="claw-mono" title={new Date(e.time).toLocaleString()}>{time(e.time)}</span> },
    { id: 'level', header: 'Level', accessor: (e) => e.level, cell: (e) => <StatusIndicator tone={LEVEL[e.level].tone} size="sm">{LEVEL[e.level].label}</StatusIndicator> },
    { id: 'component', header: 'Component', accessor: (e) => e.component ?? '', cell: (e) => <span className="claw-mono">{e.component ?? '—'}</span> },
    {
      id: 'msg', header: 'Message', rowHeader: true, wrap: true, accessor: 'msg',
      cell: (e) => <span>{e.msg}{summary(e) && <><br /><Text size="sm" tone="secondary" className="claw-mono claw-break">{summary(e)}</Text></>}</span>,
    },
    {
      id: 'request', header: 'Request', accessor: (e) => e.requestId ?? '',
      cell: (e) => (e.requestId
        ? <Button size="sm" variant="tertiary" onClick={(ev) => { ev.stopPropagation(); apply({ ...filters, requestId: e.requestId! }); }}><span className="claw-mono">{e.requestId.slice(0, 12)}…</span></Button>
        : '—'),
    },
  ];

  return (
    <Page title="Logs" subtitle="Recent server log records, redacted when written">
      {error && <MessageStrip tone="error" title="Cannot load logs">{error}</MessageStrip>}
      <form
        onSubmit={(e) => { e.preventDefault(); apply(draft); }}
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))', gap: 'var(--eui-space-3, 0.75rem)', alignItems: 'end' }}
      >
        <Select label="Level (at least)" value={draft.level || 'any'} onChange={(v) => apply({ ...draft, level: v === 'any' || !v ? '' : (v as LogLevelName) })}
          options={[{ value: 'any', label: 'Any level' }, ...LOG_LEVEL_NAMES.map((l) => ({ value: l, label: LEVEL[l].label }))]} />
        <Select label="Component" value={draft.component || 'any'} onChange={(v) => apply({ ...draft, component: v === 'any' || !v ? '' : v })}
          options={[{ value: 'any', label: 'Any component' }, ...(page?.components ?? []).map((c) => ({ value: c, label: c }))]} />
        <Input label="Search" value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} placeholder="Text in the message or fields" />
        <Input label="Request ID" className="claw-mono" value={draft.requestId} onChange={(e) => setDraft({ ...draft, requestId: e.target.value })} placeholder="req_…" />
        <Input label="Provider ID" className="claw-mono" value={draft.providerId} onChange={(e) => setDraft({ ...draft, providerId: e.target.value })} />
        <Input label="User ID" className="claw-mono" value={draft.userId} onChange={(e) => setDraft({ ...draft, userId: e.target.value })} />
        <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', flexWrap: 'wrap' }}>
          <Button type="submit" variant="primary">Apply</Button>
          <Button variant="tertiary" onClick={() => apply({ level: '', component: '', requestId: '', providerId: '', userId: '', q: '' })}>Clear</Button>
        </div>
        <Switch label="Follow new records" checked={follow} onChange={setFollow} />
      </form>

      <Table
        caption={`Log records (${items.length}${page?.hasOlder ? '+' : ''})`}
        columns={columns}
        data={items}
        getRowId={(e) => String(e.seq)}
        getRowLabel={(e) => `${LEVEL[e.level].label} ${e.msg}`}
        onRowClick={setSelected}
        loading={loading && !items.length}
        emptyState="No log records match these filters."
      />
      {page?.hasOlder && <div><Button variant="secondary" onClick={() => void loadOlder()}>Load older records</Button></div>}
      <Text size="sm" tone="secondary">
        The server keeps the latest {page?.capacity.toLocaleString() ?? '…'} records in memory
        {page?.oldestTime ? ` (since ${new Date(page.oldestTime).toLocaleString()})` : ''}; they are lost on restart.
        For longer history, collect the server's output. Secrets are removed before records are stored.
      </Text>

      <Dialog open={selected !== null} onClose={() => setSelected(null)} size="lg" title="Log record" footer={<Button variant="primary" onClick={() => setSelected(null)}>Close</Button>}>
        {selected && (
          <>
            <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', alignItems: 'center', flexWrap: 'wrap' }}>
              <StatusIndicator tone={LEVEL[selected.level].tone}>{LEVEL[selected.level].label}</StatusIndicator>
              <span className="claw-mono">{new Date(selected.time).toISOString()}</span>
              <CopyButton value={JSON.stringify(selected, null, 2)} label="Copy as JSON" size="sm" />
            </div>
            <Text as="p">{selected.msg}</Text>
            <pre className="claw-mono claw-code">{JSON.stringify({ component: selected.component, requestId: selected.requestId, providerId: selected.providerId, userId: selected.userId, ...selected.fields }, null, 2)}</pre>
          </>
        )}
      </Dialog>
    </Page>
  );
}
