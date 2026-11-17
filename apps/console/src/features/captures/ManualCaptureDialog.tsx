import { useEffect, useState } from 'react';
import { Button, Dialog, FieldHelp, Input, MessageStrip, NumberInput, Select, useToast, WithFieldHelp } from '@enterprise-ui/react';
import { MANUAL_CAPTURE_MAX_COUNT, MANUAL_CAPTURE_MAX_MINUTES, type ProviderInfo } from '@clawrouter/shared';
import { ApiClientError } from '../../services/api-client.ts';
import { startManualCapture } from '../../services/captures.ts';
import { fetchProviders } from '../../services/providers.ts';

/**
 * Starts a manual capture: the next N requests that match are kept even when they
 * succeed, for replies that look wrong without an error (a provider field read
 * wrongly, text cut off, a tool call lost). One at a time; it ends after N
 * requests or the time limit.
 */
export function ManualCaptureDialog({ open, onClose, onStarted }: { open: boolean; onClose: () => void; onStarted: () => void }) {
  const toast = useToast();
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [providerId, setProviderId] = useState('any');
  const [model, setModel] = useState('');
  const [count, setCount] = useState<number | null>(5);
  const [minutes, setMinutes] = useState<number | null>(60);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setIssues({});
    const controller = new AbortController();
    // Without providers.read the list is unavailable: the capture then covers every provider.
    fetchProviders(controller.signal).then(setProviders).catch(() => setProviders([]));
    return () => controller.abort();
  }, [open]);

  const start = async () => {
    setSaving(true);
    setError(null);
    try {
      await startManualCapture({ providerId: providerId === 'any' ? null : providerId, model: model.trim() || null, count: count ?? 0, minutes: minutes ?? 0 });
      toast.show({ tone: 'success', title: 'Manual capture started', description: `The next ${count} matching request${count === 1 ? '' : 's'} will be captured.` });
      onStarted();
      onClose();
    } catch (err) {
      if (err instanceof ApiClientError && err.issues.length) setIssues(Object.fromEntries(err.issues.map((i) => [i.path, i.message])));
      setError(err instanceof Error ? err.message : 'Could not start the capture.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open} onClose={onClose} title="Capture the next requests" size="md"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon="record" onClick={() => void start()} loading={saving}>Start capturing</Button>
      </>}
    >
      <MessageStrip tone="information">
        Errors are captured on their own. Use this when replies look wrong but nothing fails: matching requests are kept even when they succeed.
      </MessageStrip>
      {error && <MessageStrip tone="error">{error}</MessageStrip>}
      <WithFieldHelp label="Provider" help="Only requests that tried this provider are captured. Any: every provider.">
        <Select label="Provider" value={providerId} onChange={(v) => setProviderId(v ?? 'any')}
          options={[{ value: 'any', label: 'Any provider' }, ...(providers ?? []).map((p) => ({ value: p.id, label: p.name }))]} />
      </WithFieldHelp>
      <Input label="Model" className="claw-mono" placeholder="Any model" value={model} onChange={(e) => setModel(e.target.value)} error={issues.model}
        description="Empty = any model."
        endAdornment={<FieldHelp label="Model">An alias or a provider/model reference, as the client asks for it or as ClawRouter routes it (for example gpt-4o-mini or groq/openai/gpt-oss-20b).</FieldHelp>} />
      <NumberInput label="Requests to capture" min={1} max={MANUAL_CAPTURE_MAX_COUNT} step={1} value={count} onChange={setCount} error={issues.count}
        description={`1–${MANUAL_CAPTURE_MAX_COUNT}`} />
      <NumberInput label="Stop after" unit="minutes" min={1} max={MANUAL_CAPTURE_MAX_MINUTES} step={5} value={minutes} onChange={setMinutes} error={issues.minutes}
        description={`1–${MANUAL_CAPTURE_MAX_MINUTES}. The capture ends after that many requests or this long, whichever comes first.`} />
    </Dialog>
  );
}
