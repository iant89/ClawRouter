import { useCallback, useEffect, useState } from 'react';
import {
  AlertDialog, Button, MessageStrip, OverflowMenu, Page, RefreshControl, StatusIndicator, Table, Text, useToast, type TableColumn,
} from '@enterprise-ui/react';
import type { ApiKeyInfo, ApiKeyStatus, CreateApiKeyRequest, CreatedApiKey, RateLimit } from '@clawrouter/shared';
import { ApiClientError } from '../../services/api-client.ts';
import { createApiKey, fetchApiKeys, revokeApiKey } from '../../services/gateway.ts';
import { fetchModels } from '../../services/models.ts';
import { fetchRouting } from '../../services/routing.ts';
import { formatRelative } from '../../services/format.ts';
import { updateApiKey } from '../../services/rate-limits.ts';
import { describeLimit } from '../rate-limits/rate-limit-format.ts';
import { KeyLimitDialog } from './KeyLimitDialog.tsx';
import { usePermissions } from '../auth/AuthContext.tsx';
import { CreateKeyDialog } from './CreateKeyDialog.tsx';

const STATUS: Record<ApiKeyStatus, { tone: 'success' | 'warning' | 'neutral'; label: string }> = {
  ACTIVE: { tone: 'success', label: 'Active' },
  EXPIRED: { tone: 'warning', label: 'Expired' },
  REVOKED: { tone: 'neutral', label: 'Revoked' },
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

/**
 * Gateway → API Access: keys for external AI clients on /v1 (spec §14, §32).
 * Keys are shown once at creation; afterwards only their prefix is visible.
 */
export function ApiAccessPage() {
  const toast = useToast();
  const perms = usePermissions();
  const canWrite = perms.can('api_keys.write');
  const canRouting = perms.can('routing.read');
  const canModels = perms.can('models.read');
  const [keys, setKeys] = useState<ApiKeyInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date>();
  const [reloadKey, setReloadKey] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyInfo | null>(null);
  const [modelOptions, setModelOptions] = useState<{ value: string; label: string; description?: string }[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetchApiKeys(controller.signal)
      .then((k) => { setKeys(k); setError(null); setLastUpdated(new Date()); })
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load API keys.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reloadKey]);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // Model choices for the "allowed models" field; optional, so failures (e.g. no models.read) just leave it empty.
  useEffect(() => {
    if (!dialogOpen || modelOptions.length) return;
    const controller = new AbortController();
    const aliases = canRouting ? fetchRouting(controller.signal).then((r) => r.aliases.map((a) => ({ value: a.name, label: a.name, description: `Alias${a.description ? ` · ${a.description}` : ''}` }))).catch(() => []) : Promise.resolve([]);
    const models = canModels ? fetchModels({ page: 1, pageSize: 200 }, controller.signal).then((r) => r.items.map((m) => ({ value: m.ref, label: m.ref, description: m.displayName }))).catch(() => []) : Promise.resolve([]);
    void Promise.all([aliases, models]).then(([a, m]) => { if (!controller.signal.aborted) setModelOptions([...a, ...m]); });
    return () => controller.abort();
  }, [dialogOpen, modelOptions.length, canRouting, canModels]);

  const create = async (body: CreateApiKeyRequest) => {
    setSaving(true);
    try {
      setCreated(await createApiKey(body));
      setServerError(null);
      reload();
    } catch (err) {
      setServerError(err instanceof ApiClientError && err.issues.length ? err.issues.map((i) => i.message).join(' ') : err instanceof Error ? err.message : 'Could not create the key.');
    } finally {
      setSaving(false);
    }
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setCreated(null); // drop the secret from memory
    setServerError(null);
  };

  const [limitKey, setLimitKey] = useState<ApiKeyInfo | null>(null);
  const [limitSaving, setLimitSaving] = useState(false);
  const [limitError, setLimitError] = useState<string | null>(null);
  const saveLimit = async (rateLimit: RateLimit | null) => {
    if (!limitKey) return;
    setLimitSaving(true);
    try {
      await updateApiKey(limitKey.id, { rateLimit });
      toast.show({ tone: 'success', title: 'Rate limit saved', description: `${limitKey.name}: ${rateLimit ? describeLimit(rateLimit) : 'default limit'}` });
      setLimitKey(null);
      setLimitError(null);
      reload();
    } catch (err) {
      setLimitError(err instanceof ApiClientError && err.issues.length ? err.issues.map((i) => i.message).join(' ') : err instanceof Error ? err.message : 'Could not save the limit.');
    } finally {
      setLimitSaving(false);
    }
  };

  const confirmRevoke = async () => {
    if (!revoking) return;
    try {
      await revokeApiKey(revoking.id);
      toast.show({ tone: 'success', title: 'API key revoked', description: `${revoking.name} (${revoking.prefix}…) no longer works.` });
      reload();
    } catch (err) {
      toast.show({ tone: 'error', title: 'Could not revoke the key', description: err instanceof Error ? err.message : undefined, duration: 10_000 });
    } finally {
      setRevoking(null);
    }
  };

  const columns: TableColumn<ApiKeyInfo>[] = [
    { id: 'name', header: 'Name', rowHeader: true, accessor: (k) => k.name, wrap: true },
    { id: 'prefix', header: 'Key', accessor: (k) => k.prefix, cell: (k) => <span className="claw-mono">{k.prefix}…</span> },
    { id: 'status', header: 'Status', accessor: (k) => k.status, cell: (k) => <StatusIndicator tone={STATUS[k.status].tone} size="sm">{STATUS[k.status].label}</StatusIndicator> },
    {
      id: 'models', header: 'Allowed models', accessor: (k) => k.allowedModels.join(', '), wrap: true,
      cell: (k) => (k.allowedModels.length ? <span className="claw-mono">{k.allowedModels.join(', ')}</span> : <Text tone="secondary">Any model</Text>),
    },
    { id: 'limit', header: 'Rate limit', wrap: true, accessor: (k) => (k.rateLimit ? describeLimit(k.rateLimit) : ''), cell: (k) => (k.rateLimit ? describeLimit(k.rateLimit) : <Text tone="secondary">Default</Text>) },
    { id: 'used', header: 'Last used', accessor: (k) => k.lastUsedAt ?? '', cell: (k) => (k.lastUsedAt ? <span title={when(k.lastUsedAt)}>{formatRelative(k.lastUsedAt)}</span> : <Text tone="secondary">Never</Text>) },
    { id: 'expires', header: 'Expires', accessor: (k) => k.expiresAt ?? '', cell: (k) => (k.expiresAt ? when(k.expiresAt) : <Text tone="secondary">Never</Text>) },
    { id: 'created', header: 'Created', accessor: (k) => k.createdAt, cell: (k) => <span>{when(k.createdAt)}{k.createdBy && <Text size="sm" tone="secondary"> by {k.createdBy.username}</Text>}</span> },
    {
      id: 'actions', header: 'Actions', align: 'end',
      cell: (k) => (canWrite && k.status === 'ACTIVE'
        ? <OverflowMenu label={`Actions for ${k.name}`} items={[{ id: 'limit', label: 'Change rate limit' }, { type: 'separator' }, { id: 'revoke', label: 'Revoke key', destructive: true }]} onAction={(id) => (id === 'limit' ? (setLimitError(null), setLimitKey(k)) : setRevoking(k))} />
        : null),
    },
  ];

  const active = keys?.filter((k) => k.status === 'ACTIVE').length ?? 0;
  return (
    <Page
      title="API Access"
      subtitle="Keys for applications calling the gateway at /v1"
      actions={
        <>
          <RefreshControl onRefresh={reload} refreshing={loading} lastUpdated={lastUpdated} intervals={[]} />
          {canWrite && <Button variant="primary" icon="add" onClick={() => setDialogOpen(true)}>Create key</Button>}
        </>
      }
    >
      {error && <MessageStrip tone="error" title="Cannot load API keys">{error}</MessageStrip>}
      <Text tone="secondary">
        Clients send the key as <span className="claw-mono">Authorization: Bearer crk_…</span> to the OpenAI-compatible endpoints
        <span className="claw-mono"> /v1/chat/completions</span>, <span className="claw-mono">/v1/embeddings</span> and <span className="claw-mono">/v1/models</span>.
      </Text>
      <Table
        caption={`API keys (${active} active)`}
        columns={columns}
        data={keys ?? []}
        getRowId={(k) => k.id}
        getRowLabel={(k) => `${k.name}, ${k.prefix}`}
        loading={loading && !keys}
        emptyState={canWrite ? 'No API keys yet. Create one for each application that calls the gateway.' : 'No API keys yet.'}
      />

      <CreateKeyDialog open={dialogOpen} modelOptions={modelOptions} onClose={closeDialog} onCreate={create} created={created} saving={saving} serverError={serverError} />
      <KeyLimitDialog apiKey={limitKey} onClose={() => setLimitKey(null)} onSave={saveLimit} saving={limitSaving} serverError={limitError} />
      <AlertDialog open={revoking !== null} tone="warning" title="Revoke this API key?" confirmLabel="Revoke" onCancel={() => setRevoking(null)} onConfirm={confirmRevoke}>
        {revoking && `Applications using "${revoking.name}" (${revoking.prefix}…) will get 401 errors immediately. This cannot be undone.`}
      </AlertDialog>
    </Page>
  );
}
