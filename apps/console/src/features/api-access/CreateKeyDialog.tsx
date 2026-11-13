import { useEffect, useState } from 'react';
import { Button, CopyButton, Dialog, Form, Input, MessageStrip, MultiSelect, Text } from '@enterprise-ui/react';
import type { CreateApiKeyRequest, CreatedApiKey, RateLimit } from '@clawrouter/shared';
import { KeyLimitFields } from './KeyLimitDialog.tsx';
import { ExpiryField, NEVER, toKeyExpiry, type ExpiryDraft } from './ExpiryField.tsx';

/**
 * Create an API key. After creation the dialog shows the key once, with a copy
 * button and a curl example; closing the dialog discards it from memory.
 */
export function CreateKeyDialog({ open, modelOptions, onClose, onCreate, created, saving, serverError, withLimits = true, title = 'Create API key', intro }: {
  /** Administrators set per-key limits; own keys use the default. */
  withLimits?: boolean;
  title?: string;
  intro?: React.ReactNode;
  open: boolean;
  /** Aliases and model references a key can be limited to. */
  modelOptions: { value: string; label: string; description?: string }[];
  onClose: () => void;
  onCreate: (body: CreateApiKeyRequest) => void;
  created: CreatedApiKey | null;
  saving: boolean;
  serverError: string | null;
}) {
  const [name, setName] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<ExpiryDraft>(NEVER);
  const [rateLimit, setRateLimit] = useState<RateLimit | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setModels([]);
    setExpiry(NEVER);
    setRateLimit(null);
    setError(null);
  }, [open]);

  const submit = () => {
    if (!name.trim()) return setError('Give the key a name, e.g. the application that will use it.');
    const { expiry: chosen, error: invalid } = toKeyExpiry(expiry);
    if (!chosen) return setError(invalid ?? 'Check the expiry.');
    setError(null);
    onCreate({ name: name.trim(), allowedModels: models, expiry: chosen, ...(withLimits ? { rateLimit } : {}) });
  };

  if (created) {
    const example = `curl ${location.origin}/v1/chat/completions \\\n  -H "Authorization: Bearer ${created.secret}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "${created.key.allowedModels[0] ?? 'MODEL'}", "messages": [{"role": "user", "content": "Hello"}]}'`;
    return (
      <Dialog open={open} onClose={onClose} size="lg" title={`API key "${created.key.name}" created`}
        footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <MessageStrip tone="warning" title="Copy the key now">
          This is the only time the key is shown. ClawRouter stores only a hash of it; if it is lost, revoke it and create a new one.
        </MessageStrip>
        <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', alignItems: 'center', flexWrap: 'wrap' }}>
          <code className="claw-mono claw-secret" aria-label="API key">{created.secret}</code>
          <CopyButton value={created.secret} label="Copy key" />
        </div>
        <Text as="strong">Example request</Text>
        <pre className="claw-mono claw-code">{example}</pre>
        <div><CopyButton value={example} label="Copy example" size="sm" /></div>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title={title}
      footer={
        <>
          <Button variant="primary" loading={saving} onClick={submit}>Create key</Button>
          <Button variant="tertiary" onClick={onClose}>Cancel</Button>
        </>
      }>
      <Form onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        {(error ?? serverError) && <MessageStrip tone="error" announce="assertive">{error ?? serverError}</MessageStrip>}
        {intro}
        <Input label="Name" required description="Who or what uses this key, e.g. ci-pipeline." value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        <MultiSelect label="Allowed models" description="Leave empty to allow every model and alias." options={modelOptions} value={models} onChange={setModels} placeholder="Any model" />
        <ExpiryField value={expiry} onChange={setExpiry} />
        {withLimits && <KeyLimitFields value={rateLimit} onChange={setRateLimit} />}
      </Form>
    </Dialog>
  );
}
