import { Card, Dashboard, DashboardWidget, DescriptionList, List, MessageStrip, MetricCard, Page, RefreshControl, StatusIndicator } from '@enterprise-ui/react';
import { HEALTH_LABEL, HEALTH_TONE, HealthStateIndicator } from '../../components/custom/HealthStateIndicator.tsx';
import { componentLabel, formatTime, formatUptime } from '../../services/format.ts';
import { useRouter } from '../../app/router.tsx';
import { useHealth } from '../health/HealthContext.tsx';
import { GatewayActivity } from './GatewayActivity.tsx';
import { usePermissions, useSession } from '../auth/AuthContext.tsx';


export function DashboardPage() {
  const { data, error, loading, lastUpdated, refresh } = useHealth();
  const { navigate } = useRouter();
  const { roles } = useSession();
  const perms = usePermissions();
  const canHealth = perms.can('health.read');
  const canRequests = perms.can('requests.read');
  const database = data?.checks.find((c) => c.component === 'database');
  const issues = data?.checks.filter((c) => c.status !== 'HEALTHY' && c.status !== 'DISABLED') ?? [];

  return (
    <Page
      title="Dashboard"
      subtitle="Is the AI gateway working?"
      actions={<RefreshControl onRefresh={refresh} refreshing={loading} lastUpdated={lastUpdated} intervals={[]} />}
    >
      {roles.length === 0 && (
        <MessageStrip tone="information" title="No role assigned">
          You are signed in, but no role has been assigned to you yet, so there is nothing else you can open. Ask an administrator for access.
        </MessageStrip>
      )}
      {error && (
        <MessageStrip tone="error" title="Cannot load system health">
          {error.message}
        </MessageStrip>
      )}

      <Dashboard title="System health" columns={{ base: 1, sm: 2, lg: 4 }}>
        <MetricCard
          title="Platform health"
          value={data ? HEALTH_LABEL[data.status] : '—'}
          tone={data && HEALTH_TONE[data.status] !== 'neutral' ? (HEALTH_TONE[data.status] as 'success' | 'warning' | 'error' | 'information') : undefined}
          icon="electrocardiogram"
          loading={!data && loading}
          footer={data ? `${data.checks.length} checks · ${formatTime(data.checkedAt)}` : undefined}
          onClick={canHealth ? () => navigate('/health') : undefined}
        />
        <MetricCard
          title="Database"
          value={database ? HEALTH_LABEL[database.status] : '—'}
          tone={database ? (HEALTH_TONE[database.status] as 'success' | 'warning' | 'error' | 'information') : undefined}
          icon="database"
          loading={!data && loading}
          footer={database ? `${database.latencyMs} ms` : undefined}
        />
        <MetricCard title="Uptime" value={data ? formatUptime(data.uptimeSeconds) : '—'} icon="past" loading={!data && loading} footer={data ? `since ${new Date(data.startedAt).toLocaleString()}` : undefined} />
        <MetricCard title="Version" value={data?.version ?? '—'} icon="it-system" loading={!data && loading} footer={data?.environment} />

        <DashboardWidget span={2}>
          <List
            header="Component status"
            onItemClick={canHealth ? () => navigate('/health') : undefined}
            emptyState={loading ? 'Loading…' : 'No components reported'}
            items={(data?.checks ?? []).map((c) => ({
              id: c.component,
              title: componentLabel(c.component),
              textValue: componentLabel(c.component),
              description: c.detail,
              trailing: <HealthStateIndicator state={c.status} size="sm" />,
            }))}
          />
        </DashboardWidget>
        <DashboardWidget span={2}>
          <Card title="Recent problems" headingLevel={3}>
            {issues.length === 0 ? (
              <StatusIndicator tone={data ? 'success' : 'information'} size="sm">{data ? 'No active problems' : 'Waiting for data'}</StatusIndicator>
            ) : (
              <DescriptionList columns={1} items={issues.map((c) => ({ term: componentLabel(c.component), description: <><HealthStateIndicator state={c.status} size="sm" /> {c.detail}</> }))} />
            )}
          </Card>
        </DashboardWidget>
      </Dashboard>

      {canRequests ? (
        <GatewayActivity canUsage={perms.can('usage.read')} />
      ) : (
        <MessageStrip tone="information" title="Gateway activity">Request metrics need the requests.read permission.</MessageStrip>
      )}
    </Page>
  );
}
