import { useEffect, useState } from 'react';
import { Button, Checkbox, Dialog, Form, IconButton, Input, MessageStrip, NumberInput, Select, Switch, Text } from '@enterprise-ui/react';
import { ALIAS_NAME_PATTERN, CAPABILITIES, DEFAULT_ROUTING_POLICY, type AliasTarget, type Capability, type ModelAlias, type ModelInfo } from '@clawrouter/shared';
import { CAPABILITY_LABEL } from '../models/ModelDialog.tsx';
import { PolicyFields } from './PolicyFields.tsx';

const blank = (): ModelAlias => ({ name: '', description: '', enabled: true, capabilities: [], targets: [], policy: null });

/**
 * Create or edit a model alias: the name clients send, the target models in
 * priority order with weights, required capabilities and an optional policy.
 * The server validates everything again when the configuration is saved.
 */
export function AliasDialog({ open, alias, models, existingNames, onClose, onSave, saving, serverError }: {
  open: boolean;
  alias: ModelAlias | null;
  models: ModelInfo[];
  /** Names already used by other aliases (lower case), to catch duplicates before saving. */
  existingNames: Set<string>;
  onClose: () => void;
  onSave: (alias: ModelAlias) => void;
  saving: boolean;
  serverError: string | null;
}) {
  const [value, setValue] = useState<ModelAlias>(blank);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setValue(alias ? structuredClone(alias) : blank());
    setError(null);
  }, [open, alias]);

  const set = <K extends keyof ModelAlias>(k: K, v: ModelAlias[K]) => setValue((x) => ({ ...x, [k]: v }));
  const setTarget = (i: number, patch: Partial<AliasTarget>) => set('targets', value.targets.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const nextPriority = value.targets.length ? Math.max(...value.targets.map((t) => t.priority)) + 1 : 0;
  const unused = models.filter((m) => !value.targets.some((t) => t.modelRef === m.ref));

  const submit = () => {
    const name = value.name.trim();
    if (!ALIAS_NAME_PATTERN.test(name)) return setError('The name must be 1–64 letters, digits, dots, dashes, colons or underscores, without "/".');
    if (existingNames.has(name.toLowerCase())) return setError(`Another alias is already called "${name}".`);
    if (!value.targets.length && !value.capabilities.length) return setError('Add at least one target model, or choose capabilities to pick models by.');
    if (value.targets.some((t) => !t.modelRef)) return setError('Choose a model for every target, or remove the empty row.');
    setError(null);
    onSave({ ...value, name, description: value.description.trim() });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={alias ? `Edit alias ${alias.name}` : 'Add alias'}
      footer={
        <>
          <Button variant="primary" loading={saving} onClick={submit}>{alias ? 'Save' : 'Add alias'}</Button>
          <Button variant="tertiary" onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <Form onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        {(error ?? serverError) && <MessageStrip tone="error" announce="assertive">{error ?? serverError}</MessageStrip>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: 'var(--eui-space-3, 0.75rem)' }}>
          <Input label="Name" required className="claw-mono" description='What clients send as "model", e.g. fast-code.' value={value.name} onChange={(e) => set('name', e.target.value)} />
          <Input label="Description" value={value.description} onChange={(e) => set('description', e.target.value)} />
        </div>

        <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 'var(--eui-space-2, 0.5rem)' }}>
          <legend><Text as="strong">Target models</Text></legend>
          <Text size="sm" tone="secondary">Lower priority runs first. Models with the same priority share traffic by weight. Without targets, any usable model with the required capabilities is used.</Text>
          {value.targets.map((t, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(12rem, 3fr) minmax(6rem, 1fr) minmax(6rem, 1fr) auto', gap: 'var(--eui-space-2, 0.5rem)', alignItems: 'end' }}>
              <Select
                label={`Target ${i + 1}`}
                value={t.modelRef || null}
                placeholder="Choose a model"
                onChange={(v) => v && setTarget(i, { modelRef: v })}
                options={[
                  ...(t.modelRef && !models.some((m) => m.ref === t.modelRef) ? [{ value: t.modelRef, label: `${t.modelRef} (no longer registered)` }] : []),
                  ...models.filter((m) => m.ref === t.modelRef || unused.includes(m)).map((m) => ({ value: m.ref, label: m.ref, description: `${m.displayName}${m.usable ? '' : ` · ${m.unusableReason}`}` })),
                ]}
              />
              <NumberInput label="Priority" min={0} max={1000} step={1} value={t.priority} onChange={(n) => setTarget(i, { priority: n ?? 0 })} />
              <NumberInput label="Weight" min={1} max={1000} step={1} value={t.weight} onChange={(n) => setTarget(i, { weight: n ?? 1 })} />
              <IconButton icon="delete" label={`Remove target ${i + 1}`} onClick={() => set('targets', value.targets.filter((_, j) => j !== i))} />
            </div>
          ))}
          <div>
            <Button size="sm" variant="tertiary" icon="add" disabled={!unused.length} onClick={() => set('targets', [...value.targets, { modelRef: '', priority: nextPriority, weight: 1 }])}>
              Add target
            </Button>
          </div>
        </fieldset>

        <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(9rem, 1fr))', gap: 'var(--eui-space-1, 0.25rem)' }}>
          <legend><Text as="strong">Required capabilities</Text></legend>
          {CAPABILITIES.map((c) => (
            <Checkbox key={c} label={CAPABILITY_LABEL[c]} checked={value.capabilities.includes(c)}
              onChange={(on) => set('capabilities', on ? [...value.capabilities, c] : value.capabilities.filter((x: Capability) => x !== c))} />
          ))}
        </fieldset>

        <Switch label="Use the default failover policy" checked={value.policy === null} onChange={(on) => set('policy', on ? null : { ...DEFAULT_ROUTING_POLICY })} />
        {value.policy && <PolicyFields value={value.policy} onChange={(p) => set('policy', p)} />}
        <Switch label="Enabled" checked={value.enabled} onChange={(on) => set('enabled', on)} />
      </Form>
    </Dialog>
  );
}
