import { useCallback } from 'react';
import { Card, Dashboard, DashboardWidget, DescriptionList, List, MessageStrip, MetricCard, StatusIndicator } from '@enterprise-ui/react';
import type { GatewayMetrics } from '@clawrouter/shared';
import { usePolling } from '../../hooks/usePolling.ts';
import { fetchGatewayMetrics } from '../../services/gateway.ts';
import { formatRelative, formatTokens, formatUsd } from '../../services/format.ts';
import { fetchRequests, fetchUsage } from '../../services/requests.ts';
import { useRouter } from '../../app/router.tsx';
import { STATUS } from '../requests/request-format.ts';

export const GATEWAY_POLL_MS = 5_000;

const errorRate = (m: GatewayMetrics) => (m.requestsLastMinute ? Math.round((m.errorsLastMinute / m.requestsLastMinute) * 1000) / 10 : 0);

/**
 * Live gateway figures from GET /api/gateway/metrics (in memory, since the server
 * started), the last 24 hours from the usage records, and the latest failed
 * requests from the request history.
 */
export function GatewayActivity({ canUsage }: { canUsage: boolean }) {
  const { navigate } = useRouter();
  const usage = usePolling(useCallback((signal: AbortSignal) => (canUsage ? fetchUsage({}, signal) : Promise.resolve(null)), [canUsage]), 60_000);
  const failures = usePolling(useCallback((signal: AbortSignal) => fetchRequests({ problemsOnly: true, pageSize: 5 }, signal), []), 30_000);
  const day = usage.data?.totals;
  const { data: m, error, loading } = usePolling(fetchGatewayMetrics, GATEWAY_POLL_MS);
  const wait = !m && loading;
  const rate = m ? errorRate(m) : 0;
  return (
    <Dashboard title="Gateway activity" description={m ? `Since the server started, ${new Date(m.startedAt).toLocaleString()}. Refreshes every 5 seconds.` : undefined} columns={{ base: 1, sm: 2, lg: 4 }}>
      {error && <MessageStrip tone="error" title="Cannot load gateway metrics">{error.message}</MessageStrip>}
      <MetricCard title="Active requests" value={m ? String(m.activeRequests) : '—'} icon="activity-items" loading={wait} footer={m ? `${m.totalRequests} completed in total` : undefined} />
      <MetricCard title="Requests / minute" value={m ? String(m.requestsLastMinute) : '—'} icon="line-chart" loading={wait}
        footer={m ? `${m.retriedRequests} retried · ${m.failedOverRequests} failed over` : undefined} />
      <MetricCard title="Error rate (1 min)" value={m ? `${rate}` : '—'} unit="%" loading={wait}
        tone={m && m.requestsLastMinute ? (rate >= 20 ? 'error' : rate > 0 ? 'warning' : 'success') : undefined}
        footer={m ? `${m.errorsLastMinute} failed in the last minute · ${m.totalErrors} in total` : undefined} />
      <MetricCard title="Average latency" value={m?.averageLatencyMs != null ? String(m.averageLatencyMs) : '—'} unit={m?.averageLatencyMs != null ? 'ms' : undefined} icon="past" loading={wait}
        footer={m ? (m.averageLatencyMs == null ? 'No requests yet' : 'Last 100 requests') : undefined} />
      <MetricCard title="Tokens (1 hour)" value={m ? formatTokens(m.tokensLastHour.input + m.tokensLastHour.output) : '—'} loading={wait}
        footer={m ? `${formatTokens(m.tokensLastHour.input)} in · ${formatTokens(m.tokensLastHour.output)} out` : undefined} />
      <MetricCard title="Refused by rate limits (1 min)" value={m ? String(m.rateLimitedLastMinute) : '—'} icon="performance" loading={wait}
        tone={m && m.rateLimitedLastMinute > 0 ? 'warning' : undefined}
        footer={m ? `${m.rateLimitedTotal} since the server started` : undefined} />
      {canUsage && (
        <MetricCard title="Estimated cost (24 h)" value={day ? formatUsd(day.costUsd) : '—'} loading={!usage.data && usage.loading}
          onClick={() => navigate('/usage')}
          footer={day ? `${formatTokens(day.inputTokens + day.outputTokens)} tokens · ${day.requests.toLocaleString()} requests` : undefined} />
      )}
      <DashboardWidget span={canUsage ? 3 : 4}>
        <List
          header="Recent failed requests"
          onItemClick={() => navigate('/requests')}
          emptyState={failures.loading && !failures.data ? 'Loading…' : 'No failed requests.'}
          items={(failures.data?.items ?? []).map((r) => ({
            id: r.id,
            title: `${r.requestedModel || '(no model)'}: ${r.errorCode ?? STATUS[r.status].label}`,
            textValue: `${r.requestedModel} ${r.errorCode ?? ''}`,
            description: `${formatRelative(r.receivedAt)} · ${r.apiKey?.name ?? 'unknown key'}${r.errorMessage ? ` · ${r.errorMessage}` : ''}`,
            trailing: <StatusIndicator tone={STATUS[r.status].tone} size="sm">{STATUS[r.status].label}</StatusIndicator>,
          }))}
        />
      </DashboardWidget>
      <Card title="Coming later" headingLevel={3}>
        <DescriptionList columns={1} items={[{ term: 'Live updates without polling', description: 'Event system — phase 11' }]} />
      </Card>
    </Dashboard>
  );
}
