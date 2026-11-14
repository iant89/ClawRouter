import { useCallback, useEffect, useState } from 'react';
import {
  AlertDialog, Button, MessageStrip, OverflowMenu, Page, Pagination, RefreshControl, SearchField, Select, StatusIndicator, Tab, Table, TabList, TabPanel, Tabs, Text, useToast, type TableColumn,
} from '@enterprise-ui/react';
import { API_KEY_STATUSES, type ApiKeyInfo, type ApiKeyStatus, type CreateApiKeyRequest, type CreatedApiKey, type RateLimit } from '@clawrouter/shared';
import { ApiClientError } from '../../services/api-client.ts';
import { createApiKey, fetchApiKeys, revokeApiKey } from '../../services/gateway.ts';
import { formatRelative } from '../../services/format.ts';
import { updateApiKey } from '../../services/rate-limits.ts';
import { describeLimit } from '../rate-limits/rate-limit-format.ts';
import { KeyLimitDialog } from './KeyLimitDialog.tsx';
import { usePermissions } from '../auth/AuthContext.tsx';
import { CreateKeyDialog } from './CreateKeyDialog.tsx';
import { useModelOptions } from './model-options.ts';
import { KEY_STATUS } from './key-status.ts';
import { describeKeyError } from './key-issues.ts';
import { KeyRequestsPanel } from './KeyRequestsPanel.tsx';
import { useRouter } from '../../app/router.tsx';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
const PAGE_SIZE = 50;

/**
 * Gateway → API Access: keys for external AI clients on /v1 (spec §14, §32).
 * Keys are shown once at creation; afterwards only their prefix is visible.
 */
export function ApiAccessPage() {
  const toast = useToast();
  const perms = usePermissions();
  const canWrite = perms.can('api_keys.write');
  const { search, navigate } = useRouter();
  const tab = new URLSearchParams(search).get('tab') === 'requests' ? 'requests' : 'keys';
  const [pendingRequests, setPendingRequests] = useState(0);
  const [keys, setKeys] = useState<ApiKeyInfo[] | null>(null);
  const [total, setTotal] = useState(0);
  const [active, setActive] = useState(0);
  const [page, setPage] = useState(1);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<ApiKeyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date>();
  const [reloadKey, setReloadKey] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyInfo | null>(null);
  const modelOptions = useModelOptions(dialogOpen);

  // Search waits until typing pauses; any filter change starts again at page 1.
  useEffect(() => {
    const timer = setTimeout(() => { setQ(text.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetchApiKeys({ page, pageSize: PAGE_SIZE, q, status }, controller.signal)
      .then((r) => {
        setKeys(r.items);
        setTotal(r.total);
        setActive(typeof r.meta.active === 'number' ? r.meta.active : 0);
        setError(null);
        setLastUpdated(new Date());
      })
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load API keys.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reloadKey, page, q, status]);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);


  const create = async (body: CreateApiKeyRequest) => {
    setSaving(true);
    try {
      setCreated(await createApiKey(body));
      setServerError(null);
      reload();
    } catch (err) {
      setServerError(describeKeyError(err, 'Could not create the key.'));
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
    { id: 'status', header: 'Status', accessor: (k) => k.status, cell: (k) => <StatusIndicator tone={KEY_STATUS[k.status].tone} size="sm">{KEY_STATUS[k.status].label}</StatusIndicator> },
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
      cell: (k) => (canWrite && (k.status === 'ACTIVE' || k.status === 'SUSPENDED')
        ? <OverflowMenu label={`Actions for ${k.name}`} items={[{ id: 'limit', label: 'Change rate limit' }, { type: 'separator' }, { id: 'revoke', label: 'Revoke key', destructive: true }]} onAction={(id) => (id === 'limit' ? (setLimitError(null), setLimitKey(k)) : setRevoking(k))} />
        : null),
    },
  ];

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
      {(() => {
        const table = (
          <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: 'var(--eui-space-3, 0.75rem)', alignItems: 'end' }}>
            <SearchField label="Search" placeholder="Name, key prefix or owner" value={text} onChange={setText} />
            <Select<ApiKeyStatus | 'any'>
              label="Status"
              value={status ?? 'any'}
              onChange={(v) => { setStatus(!v || v === 'any' ? null : v); setPage(1); }}
              options={[{ value: 'any', label: 'Any status' }, ...API_KEY_STATUSES.map((s) => ({ value: s, label: KEY_STATUS[s].label }))]}
            />
          </div>
          <Table
            caption={`API keys (${active} active${q || status ? `; ${total} match` : ''})`}
            columns={columns}
            data={keys ?? []}
            getRowId={(k) => k.id}
            getRowLabel={(k) => `${k.name}, ${k.prefix}`}
            loading={loading && !keys}
            emptyState={q || status ? 'No key matches these filters.' : canWrite ? 'No API keys yet. Create one for each application that calls the gateway.' : 'No API keys yet.'}
          />
          {total > PAGE_SIZE && <Pagination page={page} onPageChange={setPage} totalItems={total} pageSize={PAGE_SIZE} />}
          </div>
        );
        // Approvers also see key requests; a notification links straight to them (?tab=requests).
        if (!canWrite) return table;
        return (
          <Tabs value={tab} onValueChange={(t) => navigate(t === 'requests' ? '/api-access?tab=requests' : '/api-access', { replace: true })}>
            <TabList aria-label="API Access">
              <Tab value="keys">Keys</Tab>
              <Tab value="requests" count={pendingRequests || undefined}>Key requests</Tab>
            </TabList>
            <TabPanel value="keys">{table}</TabPanel>
            <TabPanel value="requests" keepMounted><KeyRequestsPanel onPendingCount={setPendingRequests} /></TabPanel>
          </Tabs>
        );
      })()}

      <CreateKeyDialog open={dialogOpen} modelOptions={modelOptions} onClose={closeDialog} onCreate={create} created={created} saving={saving} serverError={serverError} />
      <KeyLimitDialog apiKey={limitKey} onClose={() => setLimitKey(null)} onSave={saveLimit} saving={limitSaving} serverError={limitError} />
      <AlertDialog open={revoking !== null} tone="warning" title="Revoke this API key?" confirmLabel="Revoke" onCancel={() => setRevoking(null)} onConfirm={confirmRevoke}>
        {revoking && `Applications using "${revoking.name}" (${revoking.prefix}…) will get 401 errors immediately. This cannot be undone.`}
      </AlertDialog>
    </Page>
  );
}
