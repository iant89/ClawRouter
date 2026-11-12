import { useState } from 'react';
import {
  Button, Card, DescriptionList, MessageStrip, Page, RefreshControl, StatusIndicator, Table, Text, useToast, type TableColumn,
} from '@enterprise-ui/react';
import type { FieldIssue, RateLimitScope, RateLimitSettings, RateLimitUsageEntry } from '@clawrouter/shared';
import { usePolling } from '../../hooks/usePolling.ts';
import { useResource } from '../../hooks/useResource.ts';
import { useActivity, useLive, useRealtimeEvent } from '../realtime/RealtimeContext.tsx';
import { ApiClientError } from '../../services/api-client.ts';
import { fetchModels } from '../../services/models.ts';
import { fetchRateLimits, fetchRateLimitUsage, saveRateLimits } from '../../services/rate-limits.ts';
import { formatTokens } from '../../services/format.ts';
import { usePermissions } from '../auth/AuthContext.tsx';
import { describeLimit, usageLevel, usageRatio, type UsageLevel } from './rate-limit-format.ts';
import { RateLimitsDialog } from './RateLimitsDialog.tsx';

export const USAGE_POLL_MS = 5_000;

const SCOPE_LABEL: Record<RateLimitScope, string> = { global: 'Gateway', key: 'API key', user: 'User', model: 'Model', ip: 'Address' };
const LEVEL: Record<UsageLevel, { tone: 'success' | 'warning' | 'error' | 'neutral'; label: string }> = {
  ok: { tone: 'success', label: 'Within limit' },
  near: { tone: 'warning', label: 'Near limit' },
  at: { tone: 'error', label: 'At limit' },
  unlimited: { tone: 'neutral', label: 'No limit' },
};

const settingsOf = ({ perKey, perUser, perModel, global, invalidKeysPerIp }: RateLimitSettings): RateLimitSettings => ({ perKey, perUser, perModel, global, invalidKeysPerIp });

/** Gateway → Rate Limits: limits per key, user, model and gateway, and live usage against them (spec §12). */
export function RateLimitsPage() {
  const toast = useToast();
  const perms = usePermissions();
  const canWrite = perms.can('rate_limits.write');
  const canModels = perms.can('models.read');
  const { data: config, error, loading, lastUpdated, reload } = useResource(fetchRateLimits);
  const live = useLive();
  const usage = usePolling(fetchRateLimitUsage, live ? 30_000 : USAGE_POLL_MS);
  useActivity(() => void usage.refresh(), 2000);
  useRealtimeEvent('ratelimits.changed', reload, 500);
  const { data: models } = useResource(async (signal) => (canModels ? (await fetchModels({ page: 1, pageSize: 200 }, signal)).items : []));
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverIssues, setServerIssues] = useState<FieldIssue[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);

  const save = async (settings: RateLimitSettings) => {
    if (!config) return;
    setSaving(true);
    try {
      await saveRateLimits({ ...settings, version: config.version });
      toast.show({ tone: 'success', title: 'Rate limits saved', description: 'They apply to the next request.' });
      setEditing(false);
      setServerIssues([]);
      setServerError(null);
      reload();
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 409) {
        toast.show({ tone: 'warning', duration: 10_000, title: 'The rate limits were changed by someone else', description: 'The latest version has been loaded. Apply your change again.' });
        setEditing(false);
        reload();
      } else if (err instanceof ApiClientError && err.issues.length) {
        setServerIssues(err.issues);
        setServerError('Some values are not valid. See the highlighted fields.');
      } else {
        setServerError(err instanceof Error ? err.message : 'Could not save.');
      }
    } finally {
      setSaving(false);
    }
  };

  const columns: TableColumn<RateLimitUsageEntry>[] = [
    { id: 'scope', header: 'Applies to', accessor: (e) => SCOPE_LABEL[e.scope] },
    { id: 'label', header: 'Name', rowHeader: true, wrap: true, accessor: 'label', cell: (e) => <span className={e.scope === 'model' || e.scope === 'ip' ? 'claw-mono' : undefined}>{e.label}</span> },
    {
      id: 'requests', header: 'Requests (1 min)', align: 'end', accessor: (e) => e.requestsLastMinute,
      cell: (e) => <span className="claw-mono">{e.requestsLastMinute}{e.limit.requestsPerMinute !== null ? ` / ${e.limit.requestsPerMinute}` : ''}</span>,
    },
    {
      id: 'tokens', header: 'Tokens (1 min)', align: 'end', accessor: (e) => e.tokensLastMinute,
      cell: (e) => (e.scope === 'ip' ? <Text tone="secondary">—</Text> : <span className="claw-mono">{formatTokens(e.tokensLastMinute)}{e.limit.tokensPerMinute !== null ? ` / ${formatTokens(e.limit.tokensPerMinute)}` : ''}</span>),
    },
    {
      id: 'status', header: 'Status', accessor: (e) => usageRatio({ requests: e.requestsLastMinute, tokens: e.tokensLastMinute }, e.limit) ?? -1,
      cell: (e) => {
        if (e.scope === 'ip') return <StatusIndicator tone={e.blocked ? 'error' : 'warning'} size="sm">{e.blocked ? 'Blocked' : 'Invalid keys seen'}</StatusIndicator>;
        const level = LEVEL[usageLevel(usageRatio({ requests: e.requestsLastMinute, tokens: e.tokensLastMinute }, e.limit))];
        return <StatusIndicator tone={level.tone} size="sm">{level.label}</StatusIndicator>;
      },
    },
    {
      id: 'extra', header: 'In progress', align: 'end', accessor: (e) => e.concurrent ?? -1,
      cell: (e) => (e.concurrent !== undefined ? <span className="claw-mono">{e.concurrent}{config?.global.maxConcurrent ? ` / ${config.global.maxConcurrent}` : ''}</span> : null),
    },
  ];

  const u = usage.data;
  return (
    <Page
      title="Rate Limits"
      subtitle="Protect the gateway and the providers behind it"
      actions={
        <>
          <RefreshControl onRefresh={() => { reload(); void usage.refresh(); }} refreshing={loading} lastUpdated={usage.lastUpdated ?? lastUpdated} intervals={[]} />
          {canWrite && <Button variant="primary" icon="edit" disabled={!config} onClick={() => { setServerIssues([]); setServerError(null); setEditing(true); }}>Edit limits</Button>}
        </>
      }
    >
      {error && <MessageStrip tone="error" title="Cannot load the rate limits">{error}</MessageStrip>}
      {config && config.unknownModels.length > 0 && (
        <MessageStrip tone="warning" title="Limits on models that are not registered">
          {config.unknownModels.join(', ')}: these limits never apply. Remove them or register the models again.
        </MessageStrip>
      )}

      <Card title="Limits" headingLevel={2}>
        <DescriptionList
          columns={3}
          items={config ? [
            { term: 'Per API key (default)', description: describeLimit(config.perKey) },
            { term: 'Per user (all their keys)', description: describeLimit(config.perUser) },
            { term: 'Whole gateway', description: `${describeLimit(config.global)}${config.global.maxConcurrent !== null ? ` · ${config.global.maxConcurrent} at once` : ''}` },
            { term: 'Per model', description: config.perModel.length ? config.perModel.map((m) => `${m.model}: ${describeLimit(m)}`).join('; ') : 'None' },
            { term: 'Invalid keys per address', description: `${config.invalidKeysPerIp} per minute, then blocked` },
            { term: 'Last changed', description: config.updatedAt ? new Date(config.updatedAt).toLocaleString() : 'Never (defaults)' },
          ] : []}
        />
      </Card>

      <Table
        caption={u ? `Current usage · ${u.rejectedLastMinute} refused in the last minute, ${u.rejectedTotal} since the server started` : 'Current usage'}
        columns={columns}
        data={u?.entries ?? []}
        getRowId={(e) => `${e.scope}:${e.subject}`}
        getRowLabel={(e) => `${SCOPE_LABEL[e.scope]} ${e.label}`}
        loading={!u && usage.loading}
        emptyState="No gateway requests in the last minute."
      />
      {usage.error && <MessageStrip tone="error" title="Cannot load current usage">{usage.error.message}</MessageStrip>}
      <Text size="sm" tone="secondary">Counters are kept in memory and start again from zero when the server restarts. {live ? 'Updates live.' : 'Refreshes every 5 seconds.'}</Text>

      <RateLimitsDialog open={editing} value={config ? settingsOf(config) : null} models={models ?? []} onClose={() => setEditing(false)} onSave={save}
        saving={saving} serverIssues={serverIssues} serverError={serverError} />
    </Page>
  );
}
