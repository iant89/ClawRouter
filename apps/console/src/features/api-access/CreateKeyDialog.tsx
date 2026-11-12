import { useEffect, useState } from 'react';
import { Button, CopyButton, DatePicker, Dialog, Form, Input, MessageStrip, MultiSelect, Text } from '@enterprise-ui/react';
import type { CreateApiKeyRequest, CreatedApiKey, RateLimit } from '@clawrouter/shared';
import { KeyLimitFields } from './KeyLimitDialog.tsx';

/**
 * Create an API key. After creation the dialog shows the key once, with a copy
 * button and a curl example; closing the dialog discards it from memory.
 */
export function CreateKeyDialog({ open, modelOptions, onClose, onCreate, created, saving, serverError }: {
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
  const [expires, setExpires] = useState<Date | null>(null);
  const [rateLimit, setRateLimit] = useState<RateLimit | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setModels([]);
    setExpires(null);
    setRateLimit(null);
    setError(null);
  }, [open]);

  const submit = () => {
    if (!name.trim()) return setError('Give the key a name, e.g. the application that will use it.');
    let expiresAt: string | null = null;
    if (expires) {
      // Valid through the end of the chosen day, local time.
      const end = new Date(expires);
      end.setHours(23, 59, 59, 0);
      if (end.getTime() <= Date.now()) return setError('The expiry date must be in the future.');
      expiresAt = end.toISOString();
    }
    setError(null);
    onCreate({ name: name.trim(), allowedModels: models, expiresAt, rateLimit });
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
    <Dialog open={open} onClose={onClose} title="Create API key"
      footer={
        <>
          <Button variant="primary" loading={saving} onClick={submit}>Create key</Button>
          <Button variant="tertiary" onClick={onClose}>Cancel</Button>
        </>
      }>
      <Form onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        {(error ?? serverError) && <MessageStrip tone="error" announce="assertive">{error ?? serverError}</MessageStrip>}
        <Input label="Name" required description="Who or what uses this key, e.g. ci-pipeline." value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        <MultiSelect label="Allowed models" description="Leave empty to allow every model and alias." options={modelOptions} value={models} onChange={setModels} placeholder="Any model" />
        <DatePicker label="Expires" description="Optional. The key stops working after this day." value={expires} onChange={setExpires} min={new Date()} />
        <KeyLimitFields value={rateLimit} onChange={setRateLimit} />
      </Form>
    </Dialog>
  );
}
