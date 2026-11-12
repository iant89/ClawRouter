import { useCallback, useEffect, useState } from 'react';
import {
  BarChart, Dashboard, LineChart, MessageStrip, MetricCard, Page, RefreshControl, SegmentedButton, Select, Table, Text, type TableColumn,
} from '@enterprise-ui/react';
import { USAGE_GROUPS, type UsageBreakdownRow, type UsageGroup, type UsageReport } from '@clawrouter/shared';
import { fetchUsage } from '../../services/requests.ts';
import { formatCount, formatDuration, formatTokens, formatUsd } from '../../services/format.ts';

const PERIODS = [
  { value: '24h', label: '24 hours', days: 1 },
  { value: '7d', label: '7 days', days: 7 },
  { value: '30d', label: '30 days', days: 30 },
  { value: '90d', label: '90 days', days: 90 },
] as const;
type Period = (typeof PERIODS)[number]['value'];

const GROUP_LABEL: Record<UsageGroup, string> = { model: 'Model', provider: 'Provider', apiKey: 'API key', user: 'User' };

const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : '0%');

/** Gateway → Usage: requests, tokens and estimated cost over time and by model, provider, key or user (spec §23). */
export function UsagePage() {
  const [period, setPeriod] = useState<Period>('24h');
  const [groupBy, setGroupBy] = useState<UsageGroup>('model');
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date>();
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const days = PERIODS.find((p) => p.value === period)!.days;
    setLoading(true);
    fetchUsage({ from: days === 1 ? undefined : new Date(Date.now() - days * 86_400_000).toISOString(), groupBy }, controller.signal)
      .then((r) => { setReport(r); setError(null); setLastUpdated(new Date()); })
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load usage.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [period, groupBy, reloadKey]);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const t = report?.totals;
  const wait = !report && loading;
  const label = (iso: string) => (report?.bucket === 'hour'
    ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }));
  const series = (report?.series ?? []).map((b) => ({
    at: label(b.start), requests: b.requests, errors: b.errors, input: b.inputTokens, output: b.outputTokens,
  }));

  const columns: TableColumn<UsageBreakdownRow>[] = [
    { id: 'label', header: GROUP_LABEL[groupBy], rowHeader: true, wrap: true, accessor: 'label', cell: (r) => <span className={groupBy === 'model' ? 'claw-mono' : undefined}>{r.label}</span> },
    { id: 'requests', header: 'Requests', align: 'end', accessor: 'requests', cell: (r) => formatCount(r.requests) },
    { id: 'errors', header: 'Errors', align: 'end', accessor: 'errors', cell: (r) => (r.errors ? `${formatCount(r.errors)} (${pct(r.errors, r.requests)})` : '0') },
    { id: 'input', header: 'Input tokens', align: 'end', accessor: 'inputTokens', cell: (r) => formatTokens(r.inputTokens) },
    { id: 'output', header: 'Output tokens', align: 'end', accessor: 'outputTokens', cell: (r) => formatTokens(r.outputTokens) },
    {
      id: 'cost', header: 'Est. cost', align: 'end', accessor: 'costUsd',
      cell: (r) => <span className="claw-mono" title={r.unpricedRequests ? `${r.unpricedRequests} request(s) without prices are not included` : undefined}>{formatUsd(r.costUsd)}{r.unpricedRequests ? ' +?' : ''}</span>,
    },
    { id: 'latency', header: 'Avg duration', align: 'end', accessor: (r) => r.averageDurationMs ?? -1, cell: (r) => formatDuration(r.averageDurationMs) },
  ];

  return (
    <Page
      title="Usage"
      subtitle="Requests, tokens and estimated cost"
      actions={<RefreshControl onRefresh={reload} refreshing={loading} lastUpdated={lastUpdated} intervals={[]} />}
    >
      {error && <MessageStrip tone="error" title="Cannot load usage">{error}</MessageStrip>}
      <div style={{ display: 'flex', gap: 'var(--eui-space-3, 0.75rem)', alignItems: 'end', flexWrap: 'wrap' }}>
        <SegmentedButton aria-label="Period" size="sm" selectionMode="single" value={[period]}
          onChange={(v) => v[0] && setPeriod(v[0] as Period)} items={PERIODS.map((p) => ({ value: p.value, label: p.label }))} />
        <div style={{ minWidth: '12rem' }}>
          <Select label="Break down by" value={groupBy} onChange={(v) => v && setGroupBy(v as UsageGroup)}
            options={USAGE_GROUPS.map((g) => ({ value: g, label: GROUP_LABEL[g] }))} />
        </div>
      </div>

      <Dashboard title="Totals" columns={{ base: 1, sm: 2, lg: 4 }}>
        <MetricCard title="Requests" value={t ? formatCount(t.requests) : '—'} loading={wait} icon="activity-items"
          footer={t ? `${formatCount(t.errors)} did not complete (${pct(t.errors, t.requests)})` : undefined} />
        <MetricCard title="Tokens" value={t ? formatTokens(t.inputTokens + t.outputTokens) : '—'} loading={wait} icon="line-chart"
          footer={t ? `${formatTokens(t.inputTokens)} in · ${formatTokens(t.outputTokens)} out${t.estimatedTokens ? ` · ${formatTokens(t.estimatedTokens)} estimated` : ''}` : undefined} />
        <MetricCard title="Estimated cost" value={t ? formatUsd(t.costUsd) : '—'} loading={wait}
          footer={t ? (t.unpricedRequests ? `${formatCount(t.unpricedRequests)} request(s) on models without prices not included` : 'From the prices set on each model') : undefined} />
        <MetricCard title="Average duration" value={t ? formatDuration(t.averageDurationMs) : '—'} loading={wait} icon="past" />
      </Dashboard>

      <LineChart label={`Requests per ${report?.bucket ?? 'hour'}`} data={series} categoryKey="at" categoryLabel="Time"
        series={[{ key: 'requests', label: 'Requests' }, { key: 'errors', label: 'Did not complete' }]} height={220} includeZero tableToggle loading={wait} />
      <BarChart label={`Tokens per ${report?.bucket ?? 'hour'}`} data={series} categoryKey="at" categoryLabel="Time" stacked
        series={[{ key: 'input', label: 'Input tokens' }, { key: 'output', label: 'Output tokens' }]} height={220} tableToggle loading={wait}
        formatValue={(v) => formatTokens(v)} />

      <Table
        caption={`By ${GROUP_LABEL[groupBy].toLowerCase()}`}
        columns={columns}
        data={report?.breakdown ?? []}
        getRowId={(r) => r.key || r.label}
        getRowLabel={(r) => r.label}
        loading={wait}
        emptyState="No gateway requests in this period."
      />
      <Text size="sm" tone="secondary">
        Times are grouped in UTC {report?.bucket === 'day' ? 'days' : 'hours'}. Costs are estimates from the prices set on each model at the time of the request.
        Usage records are kept longer than request details.
      </Text>
    </Page>
  );
}
