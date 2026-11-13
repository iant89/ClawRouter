import { useCallback, useEffect, useState } from 'react';
import {
  Button, Dialog, MessageStrip, MultiSelect, SegmentedButton, StatusIndicator, Table, Text, TextArea, useToast, type TableColumn,
} from '@enterprise-ui/react';
import type { ApiKeyRequestInfo, KeyRequestStatus } from '@clawrouter/shared';
import { ApiClientError } from '../../services/api-client.ts';
import { formatRelative } from '../../services/format.ts';
import { approveRequest, denyRequest, fetchKeyRequests } from '../../services/key-requests.ts';
import { useRealtimeEvent } from '../realtime/RealtimeContext.tsx';
import { describeExpiry, draftOf, ExpiryField, toKeyExpiry, type ExpiryDraft } from './ExpiryField.tsx';
import { useModelOptions } from './model-options.ts';

const STATUS: Record<KeyRequestStatus, { tone: 'success' | 'warning' | 'neutral' | 'information' | 'error'; label: string }> = {
  PENDING: { tone: 'information', label: 'Pending' },
  APPROVED: { tone: 'success', label: 'Approved' },
  DENIED: { tone: 'error', label: 'Denied' },
  CANCELLED: { tone: 'neutral', label: 'Cancelled' },
  FULFILLED: { tone: 'success', label: 'Key created' },
};

/**
 * API Access → Key requests (api_keys.write): approve, with the models and
 * expiry you choose, or deny with a reason. Approving never shows you the key:
 * the requester creates it and sees it once.
 */
export function KeyRequestsPanel({ onPendingCount }: { onPendingCount: (n: number) => void }) {
  const toast = useToast();
  const [filter, setFilter] = useState<'PENDING' | 'ALL'>('PENDING');
  const [items, setItems] = useState<ApiKeyRequestInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [approving, setApproving] = useState<ApiKeyRequestInfo | null>(null);
  const [denying, setDenying] = useState<ApiKeyRequestInfo | null>(null);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  useRealtimeEvent(['api_key_request.changed'], reload, 300);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetchKeyRequests({ status: filter === 'PENDING' ? 'PENDING' : undefined, pageSize: 100 }, controller.signal),
      filter === 'PENDING' ? null : fetchKeyRequests({ status: 'PENDING', pageSize: 1 }, controller.signal),
    ]).then(([page, pending]) => {
      setItems(page.items);
      onPendingCount(pending ? pending.total : page.total);
      setError(null);
    }).catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load key requests.'); });
    return () => controller.abort();
  }, [filter, reloadKey, onPendingCount]);

  const columns: TableColumn<ApiKeyRequestInfo>[] = [
    { id: 'who', header: 'Requested by', rowHeader: true, accessor: (r) => r.requestedBy.displayName, cell: (r) => <span>{r.requestedBy.displayName} <Text size="sm" tone="secondary">({r.requestedBy.username})</Text></span> },
    { id: 'key', header: 'Key and purpose', wrap: true, accessor: (r) => r.name, cell: (r) => <span>{r.name}<br /><Text size="sm" tone="secondary">{r.purpose}</Text></span> },
    { id: 'terms', header: 'Models and expiry', wrap: true, accessor: (r) => r.allowedModels.join(', '), cell: (r) => <span>{r.allowedModels.length ? <span className="claw-mono">{r.allowedModels.join(', ')}</span> : 'Any model'}<br /><Text size="sm" tone="secondary">{describeExpiry(r.expiry)}</Text></span> },
    { id: 'status', header: 'Status', accessor: (r) => r.status, cell: (r) => <StatusIndicator tone={STATUS[r.status].tone} size="sm">{STATUS[r.status].label}</StatusIndicator> },
    {
      id: 'when', header: 'Asked / decided', wrap: true, accessor: (r) => r.createdAt,
      cell: (r) => <span>{formatRelative(r.createdAt)}{r.decidedBy && <><br /><Text size="sm" tone="secondary">{r.decidedBy.username}{r.decisionNote ? `: “${r.decisionNote}”` : ''}</Text></>}</span>,
    },
    {
      id: 'actions', header: 'Actions', align: 'end',
      cell: (r) => (r.status === 'PENDING' ? (
        <span style={{ display: 'inline-flex', gap: 'var(--eui-space-1, 0.25rem)' }}>
          <Button size="sm" variant="primary" onClick={() => setApproving(r)}>Approve…</Button>
          <Button size="sm" variant="tertiary" onClick={() => setDenying(r)}>Deny…</Button>
        </span>
      ) : null),
    },
  ];

  return (
    <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
      {error && <MessageStrip tone="error" title="Cannot load key requests">{error}</MessageStrip>}
      <div style={{ display: 'flex', gap: 'var(--eui-space-3, 0.75rem)', alignItems: 'center', flexWrap: 'wrap' }}>
        <SegmentedButton aria-label="Show" items={[{ value: 'PENDING', label: 'Waiting' }, { value: 'ALL', label: 'All' }]} value={[filter]} onChange={(v) => v[0] && setFilter(v[0] as 'PENDING' | 'ALL')} />
        <Text size="sm" tone="secondary">You are notified about requests from people who share none of your roles.</Text>
      </div>
      <Table
        caption="Key requests"
        hideCaption
        columns={columns}
        data={items ?? []}
        getRowId={(r) => r.id}
        getRowLabel={(r) => `${r.name} for ${r.requestedBy.username}`}
        loading={!items && !error}
        emptyState={filter === 'PENDING' ? 'No requests are waiting.' : 'No key requests yet.'}
      />
      <ApproveDialog
        request={approving}
        onClose={() => setApproving(null)}
        onDone={(r) => {
          setApproving(null);
          toast.show({ tone: 'success', title: 'Request approved', description: `${r.requestedBy.displayName} can now create "${r.name}".` });
          reload();
        }}
      />
      <DenyDialog
        request={denying}
        onClose={() => setDenying(null)}
        onDone={(r) => {
          setDenying(null);
          toast.show({ tone: 'success', title: 'Request denied', description: `${r.requestedBy.displayName} was told why.` });
          reload();
        }}
      />
    </div>
  );
}

const messageOf = (err: unknown, fallback: string) =>
  err instanceof ApiClientError && err.issues.length ? err.issues.map((i) => `${i.path}: ${i.message}`).join('; ') : err instanceof Error ? err.message : fallback;

function ApproveDialog({ request, onClose, onDone }: { request: ApiKeyRequestInfo | null; onClose: () => void; onDone: (r: ApiKeyRequestInfo) => void }) {
  const modelOptions = useModelOptions(request !== null);
  const [models, setModels] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<ExpiryDraft>(draftOf({ type: 'never' }));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!request) return;
    setModels(request.allowedModels);
    setExpiry(draftOf(request.expiry));
    setNote('');
    setError(null);
  }, [request]);

  const options = [...modelOptions, ...models.filter((m) => !modelOptions.some((o) => o.value === m)).map((m) => ({ value: m, label: m }))];
  const save = async () => {
    if (!request) return;
    const { expiry: chosen, error: invalid } = toKeyExpiry(expiry);
    if (!chosen) return setError(invalid ?? 'Check the expiry.');
    setSaving(true);
    setError(null);
    try {
      onDone(await approveRequest(request.id, { allowedModels: models, expiry: chosen, ...(note.trim() ? { note: note.trim() } : {}) }));
    } catch (err) {
      setError(messageOf(err, 'Could not approve the request.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={request !== null} onClose={onClose} title={request ? `Approve "${request.name}" for ${request.requestedBy.displayName}` : 'Approve'}
      footer={
        <>
          <Button variant="primary" loading={saving} onClick={() => void save()}>Approve</Button>
          <Button variant="tertiary" onClick={onClose}>Cancel</Button>
        </>
      }>
      <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
        {error && <MessageStrip tone="error" announce="assertive">{error}</MessageStrip>}
        {request && <Text as="p">“{request.purpose}”</Text>}
        <Text as="p" size="sm" tone="secondary">You can narrow what was asked for. The requester creates the key and sees it once; you never see it.</Text>
        <MultiSelect label="Models" description="Empty allows every model and alias." options={options} value={models} onChange={setModels} placeholder="Any model" />
        <ExpiryField value={expiry} onChange={setExpiry} label="Expiry (counted from when the key is created)" />
        <TextArea label="Note for the requester" description="Optional." value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} autoResize />
      </div>
    </Dialog>
  );
}

function DenyDialog({ request, onClose, onDone }: { request: ApiKeyRequestInfo | null; onClose: () => void; onDone: (r: ApiKeyRequestInfo) => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setReason('');
    setError(null);
  }, [request]);

  const save = async () => {
    if (!request) return;
    if (!reason.trim()) return setError('Tell the requester why, so they know what to do instead.');
    setSaving(true);
    try {
      onDone(await denyRequest(request.id, { reason: reason.trim() }));
    } catch (err) {
      setError(messageOf(err, 'Could not deny the request.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={request !== null} onClose={onClose} title={request ? `Deny "${request.name}"?` : 'Deny'}
      footer={
        <>
          <Button variant="primary" loading={saving} onClick={() => void save()}>Deny request</Button>
          <Button variant="tertiary" onClick={onClose}>Cancel</Button>
        </>
      }>
      <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
        {error && <MessageStrip tone="error" announce="assertive">{error}</MessageStrip>}
        <TextArea label="Reason" required description={request ? `${request.requestedBy.displayName} is notified with this reason.` : undefined} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoResize />
      </div>
    </Dialog>
  );
}
