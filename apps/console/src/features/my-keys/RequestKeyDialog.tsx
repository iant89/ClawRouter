import { useEffect, useState } from 'react';
import { Button, Dialog, Form, Input, MessageStrip, MultiSelect, Text, TextArea } from '@enterprise-ui/react';
import type { ApiKeyRequestInfo } from '@clawrouter/shared';
import { requestKey } from '../../services/key-requests.ts';
import { ExpiryField, NEVER, toKeyExpiry, type ExpiryDraft } from '../api-access/ExpiryField.tsx';
import type { ModelOption } from '../api-access/model-options.ts';
import { describeKeyError } from '../api-access/key-issues.ts';

/**
 * Ask for an API key (for users who may not create one). People who can create
 * keys for others, outside your own roles, are notified; you create the key
 * yourself once it is approved.
 */
export function RequestKeyDialog({ open, modelOptions, onClose, onSent }: { open: boolean; modelOptions: ModelOption[]; onClose: () => void; onSent: (r: ApiKeyRequestInfo) => void }) {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<ExpiryDraft>({ ...NEVER, type: 'after', amount: 30, unit: 'days' });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setPurpose('');
    setModels([]);
    setExpiry({ ...NEVER, type: 'after', amount: 30, unit: 'days' });
    setError(null);
  }, [open]);

  const submit = async () => {
    if (!name.trim()) return setError('Give the key a name, e.g. the application that will use it.');
    if (!purpose.trim()) return setError('Say what the key is for, so an approver can decide.');
    const { expiry: chosen, error: invalid } = toKeyExpiry(expiry);
    if (!chosen) return setError(invalid ?? 'Check the expiry.');
    setSaving(true);
    setError(null);
    try {
      onSent(await requestKey({ name: name.trim(), purpose: purpose.trim(), allowedModels: models, expiry: chosen }));
    } catch (err) {
      setError(describeKeyError(err, 'Could not send the request.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Request an API key"
      footer={
        <>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>Send request</Button>
          <Button variant="tertiary" onClick={onClose}>Cancel</Button>
        </>
      }>
      <Form onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        {error && <MessageStrip tone="error" announce="assertive">{error}</MessageStrip>}
        <Text as="p" size="sm" tone="secondary">
          People who can create API keys, outside your own roles, are notified. Once one approves, you create the key here and see it once.
        </Text>
        <Input label="Name" required description="Who or what will use the key, e.g. reporting-script." value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        <TextArea label="What is it for?" required description="Helps the approver decide." value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={500} showCount autoResize />
        {modelOptions.length > 0 && (
          <MultiSelect label="Models" description="Leave empty to ask for every model; the approver may narrow it." options={modelOptions} value={models} onChange={setModels} placeholder="Any model" />
        )}
        <ExpiryField value={expiry} onChange={setExpiry} label="How long the key should work" />
      </Form>
    </Dialog>
  );
}
