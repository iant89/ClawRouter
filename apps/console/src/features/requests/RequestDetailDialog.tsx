import { useEffect, useState } from 'react';
import { Button, CopyButton, DescriptionList, Dialog, MessageStrip, StatusIndicator, Table, Text, type TableColumn } from '@enterprise-ui/react';
import type { RequestAttempt, RequestDetail } from '@clawrouter/shared';
import { fetchRequest } from '../../services/requests.ts';
import { formatDuration, formatUsd } from '../../services/format.ts';
import { describeAttempts, describeTokens, outcomeLabel, STATUS } from './request-format.ts';
import { useRouter } from '../../app/router.tsx';
import { usePermissions } from '../auth/AuthContext.tsx';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

/**
 * One request: who sent it, what it asked for, how it was routed attempt by
 * attempt, and how it ended. Metadata only: prompts and answers are never stored.
 */
export function RequestDetailDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { navigate } = useRouter();
  const canLogs = usePermissions().can('logs.read');
  const [request, setRequest] = useState<RequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setRequest(null);
    setError(null);
    fetchRequest(id, controller.signal)
      .then(setRequest)
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load the request.'); });
    return () => controller.abort();
  }, [id]);

  const columns: TableColumn<RequestAttempt & { n: number }>[] = [
    { id: 'n', header: '#', accessor: 'n', align: 'end' },
    { id: 'model', header: 'Model', rowHeader: true, accessor: 'modelRef', cell: (a) => <span className="claw-mono">{a.modelRef}</span> },
    {
      id: 'outcome', header: 'Outcome', accessor: 'outcome',
      cell: (a) => (
        <StatusIndicator tone={a.outcome === 'ok' ? 'success' : a.outcome === 'skipped_rate_limit' ? 'neutral' : 'error'} size="sm">{outcomeLabel(a.outcome)}</StatusIndicator>
      ),
    },
    { id: 'took', header: 'Took', align: 'end', accessor: 'durationMs', cell: (a) => (a.outcome === 'skipped_rate_limit' ? '—' : formatDuration(a.durationMs)) },
  ];

  const r = request;
  return (
    <Dialog open={id !== null} onClose={onClose} size="lg" title="Request" footer={<Button variant="primary" onClick={onClose}>Close</Button>}>
      {error && <MessageStrip tone="error">{error}</MessageStrip>}
      {!r && !error && <Text tone="secondary">Loading…</Text>}
      {r && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eui-space-2, 0.5rem)', flexWrap: 'wrap' }}>
            <StatusIndicator tone={STATUS[r.status].tone}>{STATUS[r.status].label}</StatusIndicator>
            <span className="claw-mono">{r.id}</span>
            <CopyButton value={r.id} label="Copy request ID" size="sm" />
            {canLogs && <Button size="sm" variant="tertiary" onClick={() => navigate(`/logs?requestId=${encodeURIComponent(r.id)}`)}>Logs for this request</Button>}
          </div>
          {r.errorMessage && (
            <MessageStrip tone={r.status === 'CANCELLED' ? 'information' : 'error'} title={r.errorCode ?? undefined}>{r.errorMessage}</MessageStrip>
          )}
          <DescriptionList
            columns={2}
            items={[
              { term: 'Received', description: when(r.receivedAt) },
              { term: 'Duration', description: formatDuration(r.durationMs) },
              { term: 'Endpoint', description: <span className="claw-mono">/v1/{r.endpoint.replace('.', '/')}{r.stream ? ' (stream)' : ''}</span> },
              { term: 'HTTP status', description: r.httpStatus ?? '—' },
              { term: 'API key', description: r.apiKey ? `${r.apiKey.name} (${r.apiKey.prefix}…)` : '—' },
              { term: 'Key owner', description: r.user?.username ?? '—' },
              { term: 'Requested model', description: <span className="claw-mono">{r.requestedModel || '—'}</span> },
              { term: 'Answered by', description: r.modelRef ? <span className="claw-mono">{r.modelRef}{r.provider ? ` · ${r.provider.name}` : ''}</span> : '—' },
              { term: 'Attempts', description: describeAttempts(r) },
              { term: 'Tokens', description: `${describeTokens(r)}${r.usageSource === 'estimated' ? ' (estimated: the provider reported none)' : ''}` },
              { term: 'Estimated cost', description: r.costUsd !== null ? formatUsd(r.costUsd) : r.inputTokens ? 'Unknown (the model has no prices)' : '—' },
            ]}
          />
          {r.attemptLog.length > 0 && (
            <Table
              caption="Attempts in order"
              columns={columns}
              data={r.attemptLog.map((a, i) => ({ ...a, n: i + 1 }))}
              getRowId={(a) => String(a.n)}
              getRowLabel={(a) => `Attempt ${a.n}, ${a.modelRef}`}
            />
          )}
          <Text size="sm" tone="secondary">Prompts and answers are never stored; only these details are kept.</Text>
        </>
      )}
    </Dialog>
  );
}
