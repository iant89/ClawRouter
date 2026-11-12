import { useEffect, useState } from 'react';
import { Button, Dialog, Form, IconButton, MessageStrip, NumberInput, Select, Text } from '@enterprise-ui/react';
import type { FieldIssue, ModelInfo, ModelRateLimit, RateLimitSettings } from '@clawrouter/shared';
import { LimitFields } from './LimitFields.tsx';

const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))', gap: 'var(--eui-space-3, 0.75rem)' } as const;
const group = { border: 0, margin: 0, padding: 0, display: 'grid', gap: 'var(--eui-space-2, 0.5rem)' } as const;

/** Edits the whole rate-limit configuration; the server validates it again on save. */
export function RateLimitsDialog({ open, value, models, onClose, onSave, saving, serverIssues, serverError }: {
  open: boolean;
  value: RateLimitSettings | null;
  models: ModelInfo[];
  onClose: () => void;
  onSave: (settings: RateLimitSettings) => void;
  saving: boolean;
  serverIssues: FieldIssue[];
  serverError: string | null;
}) {
  const [draft, setDraft] = useState<RateLimitSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open && value) {
      setDraft(structuredClone(value));
      setError(null);
    }
  }, [open, value]);
  if (!draft) return null;

  const issue = (path: string) => serverIssues.find((i) => i.path === path)?.message;
  const limitErrors = (p: string) => ({ requestsPerMinute: issue(`${p}.requestsPerMinute`), tokensPerMinute: issue(`${p}.tokensPerMinute`) });
  const set = <K extends keyof RateLimitSettings>(k: K, v: RateLimitSettings[K]) => setDraft({ ...draft, [k]: v });
  const setModel = (i: number, patch: Partial<ModelRateLimit>) => set('perModel', draft.perModel.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const unused = models.filter((m) => !draft.perModel.some((x) => x.model.toLowerCase() === m.ref.toLowerCase()));

  const submit = () => {
    if (draft.perModel.some((m) => !m.model)) return setError('Choose a model for every model limit, or remove the empty row.');
    if (draft.perModel.some((m) => m.requestsPerMinute === null && m.tokensPerMinute === null)) return setError('Every model limit needs requests or tokens per minute.');
    setError(null);
    onSave(draft);
  };

  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Edit rate limits"
      footer={
        <>
          <Button variant="primary" loading={saving} onClick={submit}>Save</Button>
          <Button variant="tertiary" onClick={onClose}>Cancel</Button>
        </>
      }>
      <Form onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        {(error ?? serverError) && <MessageStrip tone="error" announce="assertive">{error ?? serverError}</MessageStrip>}
        <Text size="sm" tone="secondary">Limits are per minute over a sliding window. Leave a field empty for no limit.</Text>

        <fieldset style={group}>
          <legend><Text as="strong">Per API key</Text></legend>
          <Text size="sm" tone="secondary">Default for every key without its own limit (set on the API Access page).</Text>
          <div style={grid}><LimitFields labelPrefix="Per key: " value={draft.perKey} onChange={(v) => set('perKey', v)} errors={limitErrors('perKey')} /></div>
        </fieldset>

        <fieldset style={group}>
          <legend><Text as="strong">Per user</Text></legend>
          <Text size="sm" tone="secondary">All keys created by the same user, combined.</Text>
          <div style={grid}><LimitFields labelPrefix="Per user: " value={draft.perUser} onChange={(v) => set('perUser', v)} errors={limitErrors('perUser')} /></div>
        </fieldset>

        <fieldset style={group}>
          <legend><Text as="strong">Whole gateway</Text></legend>
          <div style={grid}>
            <LimitFields labelPrefix="Gateway: " value={draft.global} onChange={(v) => set('global', { ...draft.global, ...v })} errors={limitErrors('global')} />
            <NumberInput label="Gateway: requests at the same time" placeholder="No limit" min={1} step={1} value={draft.global.maxConcurrent}
              onChange={(n) => set('global', { ...draft.global, maxConcurrent: n })} error={issue('global.maxConcurrent')} />
          </div>
        </fieldset>

        <fieldset style={group}>
          <legend><Text as="strong">Per model</Text></legend>
          <Text size="sm" tone="secondary">Keeps a model inside its provider's quota. A model at its limit is skipped and the next model in the route is tried.</Text>
          {draft.perModel.map((m, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(12rem, 3fr) minmax(8rem, 1fr) minmax(8rem, 1fr) auto', gap: 'var(--eui-space-2, 0.5rem)', alignItems: 'end' }}>
              <Select
                label={`Model ${i + 1}`}
                value={m.model || null}
                placeholder="Choose a model"
                onChange={(v) => v && setModel(i, { model: v })}
                error={issue(`perModel[${i}].model`)}
                options={[
                  ...(m.model && !models.some((x) => x.ref.toLowerCase() === m.model.toLowerCase()) ? [{ value: m.model, label: `${m.model} (not registered)` }] : []),
                  ...models.filter((x) => x.ref === m.model || unused.includes(x)).map((x) => ({ value: x.ref, label: x.ref, description: x.displayName })),
                ]}
              />
              <LimitFields value={m} onChange={(v) => setModel(i, v)} errors={limitErrors(`perModel[${i}]`)} labelPrefix={`Model ${i + 1}: `} />
              <IconButton icon="delete" label={`Remove model limit ${i + 1}`} onClick={() => set('perModel', draft.perModel.filter((_, j) => j !== i))} />
            </div>
          ))}
          <div>
            <Button size="sm" variant="tertiary" icon="add" disabled={!unused.length}
              onClick={() => set('perModel', [...draft.perModel, { model: '', requestsPerMinute: 60, tokensPerMinute: null }])}>
              Add model limit
            </Button>
          </div>
        </fieldset>

        <fieldset style={group}>
          <legend><Text as="strong">Invalid API keys</Text></legend>
          <div style={grid}>
            <NumberInput label="Failed key checks per address per minute" description="Then every request from that address gets 429 until the minute has passed."
              min={1} max={10_000} step={1} value={draft.invalidKeysPerIp} onChange={(n) => set('invalidKeysPerIp', n ?? 1)} error={issue('invalidKeysPerIp')} />
          </div>
        </fieldset>
      </Form>
    </Dialog>
  );
}
