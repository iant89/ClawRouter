import { useCallback, useEffect, useState } from 'react';
import {
  Button, MessageStrip, Page, RefreshControl, SegmentedButton, Table, Text, Title, useToast, type TableColumn,
} from '@enterprise-ui/react';
import type { ComponentHistory, HealthCheckResult, HealthHistoryReport, HealthState } from '@clawrouter/shared';
import { HealthStateIndicator } from '../../components/custom/HealthStateIndicator.tsx';
import { HealthTimeline } from '../../components/custom/HealthTimeline.tsx';
import { componentLabel, formatRelative, formatTime } from '../../services/format.ts';
import { fetchHealthHistory } from '../../services/health.ts';
import { startOperation } from '../../services/operations.ts';
import { useRouter } from '../../app/router.tsx';
import { useRealtimeEvent } from '../realtime/RealtimeContext.tsx';
import { useHealth } from './HealthContext.tsx';

const columns: TableColumn<HealthCheckResult>[] = [
  { id: 'component', header: 'Component', rowHeader: true, accessor: (r) => componentLabel(r.component), sortable: true },
  { id: 'status', header: 'Status', accessor: 'status', cell: (r) => <HealthStateIndicator state={r.status} size="sm" />, sortable: true },
  { id: 'critical', header: 'Critical', accessor: (r) => (r.critical ? 'Yes' : 'No') },
  { id: 'latency', header: 'Latency', align: 'end', accessor: 'latencyMs', cell: (r) => <span className="claw-mono">{r.latencyMs} ms</span>, sortable: true },
  { id: 'detail', header: 'Detail', accessor: (r) => r.detail ?? '—', wrap: true },
  { id: 'checked', header: 'Checked', accessor: (r) => formatTime(r.checkedAt) },
];

const PERIODS = [
  { value: '24', label: '24 hours' },
  { value: '72', label: '3 days' },
  { value: '168', label: '7 days' },
] as const;

const pct = (a: number | null) => (a === null ? '—' : `${(Math.round(a * 1000) / 10).toFixed(a === 1 ? 0 : 1)}%`);

type Change = ComponentHistory['changes'][number] & { component: string };

/** System → Health: what each component reports now, and how it behaved over time (spec §24). */
export function HealthPage() {
  const toast = useToast();
  const { navigate } = useRouter();
  const { data, error, loading, lastUpdated, refresh } = useHealth();
  const [hours, setHours] = useState<string>('24');
  const [history, setHistory] = useState<HealthHistoryReport | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchHealthHistory(Number(hours), controller.signal)
      .then((h) => { setHistory(h); setHistoryError(null); })
      .catch((err: unknown) => { if (!controller.signal.aborted) setHistoryError(err instanceof Error ? err.message : 'Could not load health history.'); });
    return () => controller.abort();
  }, [hours, reloadKey]);
  const reloadHistory = useCallback(() => setReloadKey((k) => k + 1), []);
  // Scheduled checks run every 30 s; a status change is the moment to redraw.
  useRealtimeEvent(['health.changed', 'provider.status'], reloadHistory, 2000);
  useEffect(() => {
    const id = window.setInterval(() => document.visibilityState === 'visible' && reloadHistory(), 60_000);
    return () => window.clearInterval(id);
  }, [reloadHistory]);

  const runNow = async () => {
    setRunning(true);
    try {
      await startOperation('health.check');
      toast.show({ tone: 'information', title: 'Health checks started', description: 'Follow it under Operations.', duration: 5_000 });
      window.setTimeout(() => void refresh(), 500);
    } catch (err) {
      toast.show({ tone: 'error', title: 'Could not start the health checks', description: err instanceof Error ? err.message : undefined, duration: 10_000 });
    } finally {
      setRunning(false);
    }
  };

  const historyColumns: TableColumn<ComponentHistory>[] = [
    { id: 'component', header: 'Component', rowHeader: true, accessor: (c) => componentLabel(c.component) },
    { id: 'now', header: 'Latest', accessor: (c) => c.current ?? '', cell: (c) => (c.current ? <HealthStateIndicator state={c.current as HealthState} size="sm" /> : '—') },
    { id: 'availability', header: 'Healthy', align: 'end', accessor: (c) => c.availability ?? -1, cell: (c) => <span className="claw-mono">{pct(c.availability)}</span> },
    { id: 'changes', header: 'Changes', align: 'end', accessor: (c) => Math.max(0, c.changes.length - 1) },
    { id: 'latency', header: 'Avg check', align: 'end', accessor: (c) => c.averageLatencyMs ?? -1, cell: (c) => <span className="claw-mono">{c.averageLatencyMs === null ? '—' : `${c.averageLatencyMs} ms`}</span> },
    { id: 'timeline', header: 'Over time (oldest left)', minWidth: '16rem', accessor: () => 0, cell: (c) => <HealthTimeline history={c} bucketMinutes={history?.bucketMinutes ?? 30} /> },
  ];

  const changes: Change[] = (history?.components ?? [])
    .flatMap((c) => c.changes.filter((ch) => ch.from !== null).map((ch) => ({ ...ch, component: c.component })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 20);
  const changeColumns: TableColumn<Change>[] = [
    { id: 'when', header: 'When', accessor: 'at', cell: (c) => <span title={new Date(c.at).toLocaleString()}>{formatRelative(c.at)}</span> },
    { id: 'component', header: 'Component', rowHeader: true, accessor: (c) => componentLabel(c.component) },
    { id: 'change', header: 'Change', accessor: (c) => c.to, cell: (c) => <span>{c.from && <HealthStateIndicator state={c.from} size="sm" />} → <HealthStateIndicator state={c.to} size="sm" /></span> },
    { id: 'detail', header: 'Detail', wrap: true, accessor: (c) => c.detail ?? '—' },
  ];

  return (
    <Page
      title="Health"
      subtitle="Status of each platform component, checked by the server every 30 seconds"
      titleAddon={data ? <HealthStateIndicator state={data.status} /> : undefined}
      actions={
        <>
          <RefreshControl onRefresh={() => { void refresh(); reloadHistory(); }} refreshing={loading} lastUpdated={lastUpdated} intervals={[]} />
          <Button variant="secondary" icon="refresh" loading={running} onClick={runNow}>Run checks now</Button>
          <Button variant="tertiary" onClick={() => navigate('/operations')}>Operations</Button>
        </>
      }
    >
      {error && <MessageStrip tone="error" title="Health check unavailable">{error.message}</MessageStrip>}
      <Table
        caption="Now"
        columns={columns}
        data={data?.checks ?? []}
        getRowId={(r) => r.component}
        loading={loading && !data}
        emptyState={<Text>No health checks reported.</Text>}
      />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--eui-space-3, 0.75rem)', flexWrap: 'wrap' }}>
        <Title level={2} size="md">History</Title>
        <SegmentedButton aria-label="History period" size="sm" selectionMode="single" value={[hours]}
          onChange={(v) => v[0] && setHours(v[0])} items={PERIODS.map((p) => ({ value: p.value, label: p.label }))} />
      </div>
      {historyError && <MessageStrip tone="error" title="Cannot load health history">{historyError}</MessageStrip>}
      <Table
        caption={history ? `Per component, ${history.bucketMinutes >= 60 ? `${history.bucketMinutes / 60}-hour` : `${history.bucketMinutes}-minute`} steps` : 'Per component'}
        columns={historyColumns}
        data={history?.components ?? []}
        getRowId={(c) => c.component}
        loading={!history && !historyError}
        emptyState="No history yet: the server records a check every 30 seconds."
      />
      <Table
        caption="Recent changes"
        columns={changeColumns}
        data={changes}
        getRowId={(c) => `${c.component}:${c.at}`}
        emptyState="No status changes in this period."
      />
      <Text as="p" size="sm" tone="secondary">
        "Healthy" is the share of checks that found the component healthy (disabled components are not counted).
        History is kept for 7 days by default (CLAWROUTER_HEALTH_HISTORY_DAYS).
      </Text>
    </Page>
  );
}
