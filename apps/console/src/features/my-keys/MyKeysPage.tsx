import { useCallback, useEffect, useState } from 'react';
import {
  AlertDialog, Button, Card, Link, MessageStrip, Page, RefreshControl, StatusIndicator, Table, Text, useToast, type TableColumn,
} from '@enterprise-ui/react';
import type { ApiKeyInfo, ApiKeyRequestInfo, CreateApiKeyRequest, CreatedApiKey, KeyRequestStatus } from '@clawrouter/shared';
import { ApiClientError } from '../../services/api-client.ts';
import { formatRelative } from '../../services/format.ts';
import { cancelRequest, createKeyFromRequest, createMyKey, fetchMyKeys, fetchMyRequests, revokeMyKey } from '../../services/key-requests.ts';
import { useRouter } from '../../app/router.tsx';
import { usePermissions } from '../auth/AuthContext.tsx';
import { useRealtimeEvent } from '../realtime/RealtimeContext.tsx';
import { CreateKeyDialog } from '../api-access/CreateKeyDialog.tsx';
import { describeExpiry } from '../api-access/ExpiryField.tsx';
import { useModelOptions } from '../api-access/model-options.ts';
import { KEY_STATUS } from '../api-access/key-status.ts';
import { RequestKeyDialog } from './RequestKeyDialog.tsx';

const REQUEST_STATUS: Record<KeyRequestStatus, { tone: 'success' | 'warning' | 'neutral' | 'information' | 'error'; label: string }> = {
  PENDING: { tone: 'information', label: 'Waiting for approval' },
  APPROVED: { tone: 'success', label: 'Approved: create your key' },
  DENIED: { tone: 'error', label: 'Denied' },
  CANCELLED: { tone: 'neutral', label: 'Cancelled' },
  FULFILLED: { tone: 'neutral', label: 'Key created' },
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

/**
 * Gateway → My API keys: every signed-in user's own keys. With `api_keys.own`
 * you create keys yourself; otherwise you request one, and once it is approved
 * you create it here (the key is shown to you, once). Owner's rule.
 */
export function MyKeysPage() {
  const toast = useToast();
  const { navigate } = useRouter();
  const perms = usePermissions();
  const canOwn = perms.can('api_keys.own');
  const canWrite = perms.can('api_keys.write');
  const canRequest = !canOwn && !canWrite;
  const [keys, setKeys] = useState<ApiKeyInfo[] | null>(null);
  const [requests, setRequests] = useState<ApiKeyRequestInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date>();
  const [reloadKey, setReloadKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyInfo | null>(null);
  const modelOptions = useModelOptions(creating || requesting);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    Promise.all([fetchMyKeys(controller.signal), fetchMyRequests(controller.signal)])
      .then(([k, r]) => { setKeys(k); setRequests(r); setError(null); setLastUpdated(new Date()); })
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load your keys.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reloadKey]);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  // Decisions on requests arrive as notifications.
  useRealtimeEvent(['notification.created'], reload, 500);

  const create = async (body: CreateApiKeyRequest) => {
    setSaving(true);
    try {
      setCreated(await createMyKey({ name: body.name, allowedModels: body.allowedModels, expiry: body.expiry }));
      setServerError(null);
      reload();
    } catch (err) {
      setServerError(err instanceof ApiClientError && err.issues.length ? err.issues.map((i) => i.message).join(' ') : err instanceof Error ? err.message : 'Could not create the key.');
    } finally {
      setSaving(false);
    }
  };

  const fromRequest = async (r: ApiKeyRequestInfo) => {
    try {
      const result = await createKeyFromRequest(r.id);
      setCreated(result);
      setCreating(true);
      reload();
    } catch (err) {
      toast.show({ tone: 'error', title: 'Cannot create the key', description: err instanceof Error ? err.message : undefined, duration: 10_000 });
    }
  };

  const cancel = async (r: ApiKeyRequestInfo) => {
    try {
      await cancelRequest(r.id);
      toast.show({ tone: 'success', title: 'Request cancelled', description: r.name });
      reload();
    } catch (err) {
      toast.show({ tone: 'error', title: 'Cannot cancel the request', description: err instanceof Error ? err.message : undefined, duration: 10_000 });
    }
  };

  const confirmRevoke = async () => {
    if (!revoking) return;
    try {
      await revokeMyKey(revoking.id);
      toast.show({ tone: 'success', title: 'API key revoked', description: `${revoking.name} (${revoking.prefix}…) no longer works.` });
      reload();
    } catch (err) {
      toast.show({ tone: 'error', title: 'Could not revoke the key', description: err instanceof Error ? err.message : undefined, duration: 10_000 });
    } finally {
      setRevoking(null);
    }
  };

  const closeCreate = () => {
    setCreating(false);
    setCreated(null); // drop the secret from memory
    setServerError(null);
  };

  const keyColumns: TableColumn<ApiKeyInfo>[] = [
    { id: 'name', header: 'Name', rowHeader: true, accessor: (k) => k.name, wrap: true },
    { id: 'prefix', header: 'Key', accessor: (k) => k.prefix, cell: (k) => <span className="claw-mono">{k.prefix}…</span> },
    { id: 'status', header: 'Status', accessor: (k) => k.status, cell: (k) => <StatusIndicator tone={KEY_STATUS[k.status].tone} size="sm">{KEY_STATUS[k.status].label}</StatusIndicator> },
    { id: 'models', header: 'Models', wrap: true, accessor: (k) => k.allowedModels.join(', '), cell: (k) => (k.allowedModels.length ? <span className="claw-mono">{k.allowedModels.join(', ')}</span> : <Text tone="secondary">Any model</Text>) },
    { id: 'expires', header: 'Expires', accessor: (k) => k.expiresAt ?? '', cell: (k) => (k.expiresAt ? <span title={when(k.expiresAt)}>{when(k.expiresAt)}</span> : <Text tone="secondary">Never</Text>) },
    { id: 'used', header: 'Last used', accessor: (k) => k.lastUsedAt ?? '', cell: (k) => (k.lastUsedAt ? formatRelative(k.lastUsedAt) : <Text tone="secondary">Never</Text>) },
    {
      id: 'actions', header: 'Actions', align: 'end',
      cell: (k) => (k.status === 'ACTIVE' || k.status === 'SUSPENDED' ? <Button size="sm" variant="tertiary" onClick={() => setRevoking(k)}>Revoke</Button> : null),
    },
  ];

  const requestColumns: TableColumn<ApiKeyRequestInfo>[] = [
    { id: 'name', header: 'Key', rowHeader: true, accessor: (r) => r.name, wrap: true, cell: (r) => <span>{r.name}<br /><Text size="sm" tone="secondary">{r.purpose}</Text></span> },
    { id: 'status', header: 'Status', accessor: (r) => r.status, cell: (r) => <StatusIndicator tone={REQUEST_STATUS[r.status].tone} size="sm">{REQUEST_STATUS[r.status].label}</StatusIndicator> },
    { id: 'terms', header: 'Models and expiry', wrap: true, accessor: (r) => r.allowedModels.join(', '), cell: (r) => <span>{r.allowedModels.length ? <span className="claw-mono">{r.allowedModels.join(', ')}</span> : 'Any model'}<br /><Text size="sm" tone="secondary">{describeExpiry(r.expiry)}</Text></span> },
    {
      id: 'decision', header: 'Decision', wrap: true, accessor: (r) => r.decidedAt ?? '',
      cell: (r) => (r.decidedBy ? <span>{r.decidedBy.username}, {formatRelative(r.decidedAt!)}{r.decisionNote && <><br /><Text size="sm" tone="secondary">“{r.decisionNote}”</Text></>}</span> : <Text tone="secondary">—</Text>),
    },
    { id: 'asked', header: 'Asked', accessor: (r) => r.createdAt, cell: (r) => <span title={when(r.createdAt)}>{formatRelative(r.createdAt)}</span> },
    {
      id: 'actions', header: 'Actions', align: 'end',
      cell: (r) => (r.status === 'APPROVED'
        ? <Button size="sm" variant="primary" onClick={() => void fromRequest(r)}>Create key</Button>
        : r.status === 'PENDING' ? <Button size="sm" variant="tertiary" onClick={() => void cancel(r)}>Cancel request</Button> : null),
    },
  ];

  const approved = requests?.filter((r) => r.status === 'APPROVED').length ?? 0;
  return (
    <Page
      title="My API keys"
      subtitle="Your own keys for calling the gateway at /v1"
      actions={
        <>
          <RefreshControl onRefresh={reload} refreshing={loading} lastUpdated={lastUpdated} intervals={[]} />
          {canOwn && <Button variant="primary" icon="add" onClick={() => setCreating(true)}>Create key</Button>}
          {canRequest && <Button variant="primary" icon="add" onClick={() => setRequesting(true)}>Request a key</Button>}
        </>
      }
    >
      {error && <MessageStrip tone="error" title="Cannot load your keys">{error}</MessageStrip>}
      {approved > 0 && <MessageStrip tone="success" title="Request approved">Create your key below. It is shown once, so copy it when it appears.</MessageStrip>}
      {canWrite && !canOwn && (
        <MessageStrip tone="information">
          You create keys for applications under <Link href="/api-access" onClick={(e) => { e.preventDefault(); navigate('/api-access'); }}>API Access</Link>. Keys listed here belong to you.
        </MessageStrip>
      )}
      <Table
        caption="Your keys"
        columns={keyColumns}
        data={keys ?? []}
        getRowId={(k) => k.id}
        getRowLabel={(k) => `${k.name}, ${k.prefix}`}
        loading={loading && !keys}
        emptyState={canOwn ? 'You have no keys yet.' : canRequest ? 'You have no keys yet. Request one, and create it here once it is approved.' : 'You have no keys of your own.'}
      />
      {(canRequest || (requests?.length ?? 0) > 0) && (
        <Card title="Your requests" subtitle="Requests for keys, and what was decided." headingLevel={2} noPadding>
          <Table caption="Your key requests" hideCaption columns={requestColumns} data={requests ?? []} getRowId={(r) => r.id} getRowLabel={(r) => r.name} loading={loading && !requests} emptyState="No requests yet." />
        </Card>
      )}

      <CreateKeyDialog
        open={creating}
        title="Create a key for yourself"
        withLimits={false}
        intro={<Text as="p" size="sm" tone="secondary">The key acts for you: your rate limits apply, and it stops working if your account is disabled.</Text>}
        modelOptions={modelOptions}
        onClose={closeCreate}
        onCreate={(b) => void create(b)}
        created={created}
        saving={saving}
        serverError={serverError}
      />
      <RequestKeyDialog
        open={requesting}
        modelOptions={modelOptions}
        onClose={() => setRequesting(false)}
        onSent={(r) => {
          setRequesting(false);
          toast.show({ tone: 'success', title: 'Request sent', description: `"${r.name}" is waiting for approval. You will be notified.` });
          reload();
        }}
      />
      <AlertDialog open={revoking !== null} tone="warning" title="Revoke this API key?" confirmLabel="Revoke" onCancel={() => setRevoking(null)} onConfirm={confirmRevoke}>
        {revoking && `Anything using "${revoking.name}" (${revoking.prefix}…) will get 401 errors immediately. This cannot be undone.`}
      </AlertDialog>
    </Page>
  );
}
