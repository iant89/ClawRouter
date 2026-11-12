import { useEffect, useState } from 'react';
import { Button, Dialog, Form, MessageStrip, Switch, Text } from '@enterprise-ui/react';
import type { ApiKeyInfo, RateLimit } from '@clawrouter/shared';
import { LimitFields } from '../rate-limits/LimitFields.tsx';

const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))', gap: 'var(--eui-space-3, 0.75rem)' } as const;

/** "Use the default limit" or the key's own requests/tokens per minute. Shared by create and edit. */
export function KeyLimitFields({ value, onChange }: { value: RateLimit | null; onChange: (next: RateLimit | null) => void }) {
  return (
    <>
      <Switch label="Use the default per-key limit" checked={value === null}
        onChange={(on) => onChange(on ? null : { requestsPerMinute: 60, tokensPerMinute: null })} />
      {value && (
        <>
          <Text size="sm" tone="secondary">Leave a field empty for no limit on this key. Per-user and gateway limits still apply.</Text>
          <div style={grid}><LimitFields value={value} onChange={onChange} /></div>
        </>
      )}
    </>
  );
}

/** Changes one key's own rate limit (PATCH /api/api-keys/:id). */
export function KeyLimitDialog({ apiKey, onClose, onSave, saving, serverError }: {
  apiKey: ApiKeyInfo | null;
  onClose: () => void;
  onSave: (limit: RateLimit | null) => void;
  saving: boolean;
  serverError: string | null;
}) {
  const [value, setValue] = useState<RateLimit | null>(null);
  useEffect(() => {
    if (apiKey) setValue(apiKey.rateLimit);
  }, [apiKey]);
  return (
    <Dialog open={apiKey !== null} onClose={onClose} title={apiKey ? `Rate limit for ${apiKey.name}` : 'Rate limit'}
      footer={
        <>
          <Button variant="primary" loading={saving} onClick={() => onSave(value)}>Save</Button>
          <Button variant="tertiary" onClick={onClose}>Cancel</Button>
        </>
      }>
      <Form onSubmit={(e) => { e.preventDefault(); onSave(value); }} noValidate>
        {serverError && <MessageStrip tone="error" announce="assertive">{serverError}</MessageStrip>}
        <KeyLimitFields value={value} onChange={setValue} />
      </Form>
    </Dialog>
  );
}
