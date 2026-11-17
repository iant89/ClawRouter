import { useEffect, useState } from 'react';
import { Button, CopyButton, DescriptionList, Dialog, MessageStrip, Panel, StatusIndicator, Text } from '@enterprise-ui/react';
import { CAPTURE_TRIGGER_LABELS, type CaptureBody, type CaptureDetail, type CaptureExchange } from '@clawrouter/shared';
import { fetchCapture } from '../../services/captures.ts';
import { formatDuration } from '../../services/format.ts';
import { useRouter } from '../../app/router.tsx';
import { usePermissions } from '../auth/AuthContext.tsx';
import { outcomeLabel } from '../requests/request-format.ts';
import { formatBytes, TRIGGER_TONE } from './capture-format.ts';

/** A JSON body pretty-printed; anything else (streams, HTML) as it came. */
function readable(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function BodyBlock({ title, body, note }: { title: string; body: CaptureBody | null; note?: string }) {
  if (!body) return <Text size="sm" tone="secondary">{title}: no body.</Text>;
  return (
    <div style={{ display: 'grid', gap: 'var(--eui-space-1, 0.25rem)' }}>
      <Text size="sm" tone="secondary">
        {title} · {formatBytes(body.bytes)}{body.truncated ? ' (cut at 256 KB)' : ''}{note ? ` · ${note}` : ''}
      </Text>
      <pre className="claw-code claw-capture-body">{readable(body.text) || '(empty)'}</pre>
    </div>
  );
}

const headerText = (headers: Record<string, string>) => Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n');

function ExchangePanel({ x }: { x: CaptureExchange }) {
  const ok = x.outcome === 'ok';
  return (
    <Panel title={`Attempt ${x.attempt} · ${x.modelRef} · ${ok ? 'OK' : outcomeLabel(x.outcome)}${x.response ? ` · HTTP ${x.response.status}` : ''}`} defaultExpanded={!ok} headingLevel={4}>
      <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
        <DescriptionList
          columns={2}
          items={[
            { term: 'Provider', description: `${x.providerName ?? x.providerId}${x.providerKind ? ` (${x.providerKind})` : ''}` },
            { term: 'Took', description: formatDuration(x.durationMs) },
            { term: 'Request', description: <span className="claw-mono claw-break">{x.request.method} {x.request.url}</span> },
            { term: 'Reply', description: x.response ? `HTTP ${x.response.status}${x.response.complete ? '' : ', stopped part-way'}` : 'No reply' },
          ]}
        />
        {x.error && <MessageStrip tone="error" title="ClawRouter read it as">{x.error}</MessageStrip>}
        {x.transportError && <MessageStrip tone="warning" title="Connection">{x.transportError}</MessageStrip>}
        <Text size="sm" tone="secondary">Request headers (credentials removed)</Text>
        <pre className="claw-code claw-capture-body">{headerText(x.request.headers) || '(none)'}</pre>
        <BodyBlock title="Sent to the provider" body={x.request.body} />
        {x.response && <>
          <Text size="sm" tone="secondary">Reply headers</Text>
          <pre className="claw-code claw-capture-body">{headerText(x.response.headers) || '(none)'}</pre>
          <BodyBlock title="Raw reply" body={x.response.body} note={x.response.complete ? undefined : 'incomplete'} />
        </>}
      </div>
    </Panel>
  );
}

/** One capture: the outcome, then what the client sent, each provider call and what the client got. */
export function CaptureDetailDialog({ id, onClose, onExport, onDelete }: {
  id: string | null;
  onClose: () => void;
  onExport: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { navigate } = useRouter();
  const canLogs = usePermissions().can('logs.read');
  const [capture, setCapture] = useState<CaptureDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setCapture(null);
    setError(null);
    fetchCapture(id, controller.signal)
      .then(setCapture)
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load the capture.'); });
    return () => controller.abort();
  }, [id]);

  const c = capture;
  return (
    <Dialog
      open={id !== null} onClose={onClose} size="xl" title="Provider capture"
      footer={<>
        {c && <Button variant="secondary" icon="delete" onClick={() => onDelete(c.id)}>Delete</Button>}
        {c && <Button variant="secondary" icon="download" onClick={() => onExport(c.id)}>Export…</Button>}
        <Button variant="primary" onClick={onClose}>Close</Button>
      </>}
    >
      {error && <MessageStrip tone="error">{error}</MessageStrip>}
      {!c && !error && <Text tone="secondary">Loading…</Text>}
      {c && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eui-space-2, 0.5rem)', flexWrap: 'wrap' }}>
            <StatusIndicator tone={TRIGGER_TONE[c.trigger]}>{CAPTURE_TRIGGER_LABELS[c.trigger]}</StatusIndicator>
            <span className="claw-mono">{c.requestId}</span>
            <CopyButton value={c.requestId} label="Copy request ID" size="sm" />
            {canLogs && <Button size="sm" variant="tertiary" onClick={() => navigate(`/logs?requestId=${encodeURIComponent(c.requestId)}`)}>Logs for this request</Button>}
          </div>
          {c.outcome.errorMessage
            ? <MessageStrip tone="error" title={`${c.outcome.errorCode ?? 'Error'} · HTTP ${c.outcome.httpStatus}`}>{c.outcome.errorMessage}</MessageStrip>
            : <MessageStrip tone="success">The client got an answer (HTTP {c.outcome.httpStatus}){c.trigger === 'error' ? ' after a failed attempt' : ''}.</MessageStrip>}
          <DescriptionList
            columns={2}
            items={[
              { term: 'Captured', description: new Date(c.createdAt).toLocaleString() },
              { term: 'Endpoint', description: <span className="claw-mono">/v1/{c.endpoint.replace('.', '/')}{c.stream ? ' (stream)' : ''}</span> },
              { term: 'Requested model', description: <span className="claw-mono">{c.requestedModel || '—'}</span> },
              { term: 'Last tried', description: c.modelRef ? <span className="claw-mono">{c.modelRef}{c.providerName ? ` · ${c.providerName}` : ''}</span> : '—' },
              { term: 'Provider calls', description: c.exchangeCount },
              { term: 'Size', description: formatBytes(c.sizeBytes) },
            ]}
          />
          <Panel title="What the client sent" defaultExpanded={false} headingLevel={4}>
            <BodyBlock title="Request body" body={c.client.request.body} />
          </Panel>
          {c.exchanges.map((x, i) => <ExchangePanel key={i} x={x} />)}
          <Panel title={`What the client got${c.client.response ? ` · HTTP ${c.client.response.status}` : ''}`} defaultExpanded={false} headingLevel={4}>
            {c.client.response
              ? <BodyBlock title={c.stream ? 'Events sent' : 'Response body'} body={c.client.response.body} />
              : <Text size="sm">The request failed before an answer was written: the client got the error above.</Text>}
          </Panel>
        </>
      )}
    </Dialog>
  );
}
