import { Card, Dashboard, DescriptionList, MessageStrip, MetricCard } from '@enterprise-ui/react';
import type { GatewayMetrics } from '@clawrouter/shared';
import { usePolling } from '../../hooks/usePolling.ts';
import { fetchGatewayMetrics } from '../../services/gateway.ts';
import { formatTokens } from '../../services/format.ts';

export const GATEWAY_POLL_MS = 5_000;

/** Metrics that need later phases are listed honestly rather than faked. */
const PENDING_METRICS = [
  { term: 'Request history', description: 'Requests + usage — phase 10' },
  { term: 'Cost', description: 'Requests + usage — phase 10' },
  { term: 'Live updates without polling', description: 'Event system — phase 11' },
];

const errorRate = (m: GatewayMetrics) => (m.requestsLastMinute ? Math.round((m.errorsLastMinute / m.requestsLastMinute) * 1000) / 10 : 0);

/**
 * Live gateway figures from GET /api/gateway/metrics. They are kept in memory on
 * the server and start again from zero when it restarts (persistent history is phase 10).
 */
export function GatewayActivity() {
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
      <Card title="Coming later" headingLevel={3}>
        <DescriptionList columns={1} items={PENDING_METRICS} />
      </Card>
    </Dashboard>
  );
}
