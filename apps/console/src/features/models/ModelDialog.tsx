import { useEffect, useState } from 'react';
import { Button, Checkbox, Dialog, Form, Input, MessageStrip, NumberInput, Select, Switch, Text } from '@enterprise-ui/react';
import { CAPABILITIES, formatLifetime, type Capability, type ModelInfo, type ProviderInfo } from '@clawrouter/shared';
import { KeyLifetimeField } from '../../components/custom/KeyLifetimeField.tsx';
import { FieldHelp, WithFieldHelp } from '../../components/custom/FieldHelp.tsx';
import { ApiClientError } from '../../services/api-client.ts';
import { createModel, updateModel } from '../../services/models.ts';

export const CAPABILITY_LABEL: Record<Capability, string> = {
  CHAT: 'Chat', CODING: 'Coding', REASONING: 'Reasoning', VISION: 'Vision', EMBEDDINGS: 'Embeddings', TOOL_USE: 'Tool use', RESEARCH: 'Research',
};

interface Values {
  providerId: string;
  providerModelId: string;
  displayName: string;
  capabilities: Capability[];
  contextLength: number | null;
  maxOutputTokens: number | null;
  inputPrice: number | null;
  outputPrice: number | null;
  /** Follow the provider's published price (kept up to date automatically). */
  followPrice: boolean;
  maxKeyLifetimeHours: number | null;
  enabled: boolean;
}

const FIELD: Record<string, keyof Values> = {
  providerId: 'providerId', providerModelId: 'providerModelId', displayName: 'displayName', capabilities: 'capabilities',
  contextLength: 'contextLength', maxOutputTokens: 'maxOutputTokens', 'cost.inputPerMTok': 'inputPrice', 'cost.outputPerMTok': 'outputPrice', maxKeyLifetimeHours: 'maxKeyLifetimeHours',
};

function initial(model: ModelInfo | null, providers: ProviderInfo[]): Values {
  if (model) {
    return {
      providerId: model.providerId, providerModelId: model.providerModelId, displayName: model.displayName, capabilities: model.capabilities,
      contextLength: model.contextLength, maxOutputTokens: model.maxOutputTokens, inputPrice: model.cost?.inputPerMTok ?? null,
      outputPrice: model.cost?.outputPerMTok ?? null, followPrice: model.costSource === 'PROVIDER', enabled: model.enabled, maxKeyLifetimeHours: model.maxKeyLifetimeHours,
    };
  }
  return { providerId: providers[0]?.id ?? '', providerModelId: '', displayName: '', capabilities: ['CHAT'], contextLength: null, maxOutputTokens: null, inputPrice: null, outputPrice: null, followPrice: false, enabled: true, maxKeyLifetimeHours: null };
}

/** Shown beside both price fields. */
const PRICE_HELP = 'Per million tokens, used to estimate cost on the Usage page. Groq publishes its prices, which are filled in and kept up to date; for other providers, enter them from the provider\'s price list.';
/** Provider kinds whose model lists include prices. */
const PUBLISHES_PRICES = new Set(['groq']);

/** Add a model by hand (for providers that cannot list models) or edit one. */
export function ModelDialog({ open, model, providers, onClose, onSaved }: {
  open: boolean;
  model: ModelInfo | null;
  providers: ProviderInfo[];
  onClose: () => void;
  onSaved: (model: ModelInfo, created: boolean) => void;
}) {
  const [values, setValues] = useState<Values>(() => initial(model, providers));
  const providerLimit = providers.find((p) => p.id === values.providerId)?.maxKeyLifetimeHours ?? null;
  const [errors, setErrors] = useState<Partial<Record<keyof Values, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues(initial(model, providers));
    setErrors({});
    setFormError(null);
  }, [open, model, providers]);

  const set = <K extends keyof Values>(k: K, v: Values[K]) => setValues((x) => ({ ...x, [k]: v }));
  const toggleCap = (c: Capability, on: boolean) => set('capabilities', on ? [...values.capabilities, c] : values.capabilities.filter((x) => x !== c));

  const submit = async () => {
    const e: Partial<Record<keyof Values, string>> = {};
    if (!model && !values.providerId) e.providerId = 'Choose a provider.';
    if (!model && !values.providerModelId.trim()) e.providerModelId = "Enter the provider's model id.";
    if (/\s/.test(values.providerModelId.trim())) e.providerModelId = 'Model ids cannot contain spaces.';
    setErrors(e);
    setFormError(null);
    if (Object.keys(e).length) return;
    setSaving(true);
    const cost = values.inputPrice === null && values.outputPrice === null ? null : { inputPerMTok: values.inputPrice, outputPerMTok: values.outputPrice };
    const common = {
      displayName: values.displayName.trim() || undefined,
      capabilities: values.capabilities,
      contextLength: values.contextLength,
      maxOutputTokens: values.maxOutputTokens,
      maxKeyLifetimeHours: values.maxKeyLifetimeHours,
      enabled: values.enabled,
      // Following the provider's price: no price is sent (it stays automatic). Turning that off keeps the price as set by hand.
      ...(values.followPrice
        ? (model?.costSource === 'PROVIDER' ? {} : { costSource: 'PROVIDER' as const })
        : { cost, ...(model?.costSource === 'PROVIDER' ? { costSource: 'MANUAL' as const } : {}) }),
    };
    try {
      const saved = model
        ? await updateModel(model.id, common)
        : await createModel({ ...common, providerId: values.providerId, providerModelId: values.providerModelId.trim() });
      onSaved(saved, !model);
    } catch (err) {
      if (err instanceof ApiClientError && err.issues.length) {
        const mapped: Partial<Record<keyof Values, string>> = {};
        for (const i of err.issues) if (FIELD[i.path]) mapped[FIELD[i.path]!] = `${i.message.charAt(0).toUpperCase()}${i.message.slice(1)}.`;
        setErrors(mapped);
        if (!Object.keys(mapped).length) setFormError(err.message);
      } else {
        setFormError(err instanceof Error ? err.message : 'Could not save the model.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={model ? `Edit ${model.displayName}` : 'Add model'}
      footer={
        <>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>{model ? 'Save' : 'Add model'}</Button>
          <Button variant="tertiary" onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <Form onSubmit={(ev) => { ev.preventDefault(); void submit(); }} noValidate>
        {formError && <MessageStrip tone="error" announce="assertive">{formError}</MessageStrip>}
        <Select
          label="Provider"
          required
          disabled={!!model}
          value={values.providerId || null}
          onChange={(v) => v && set('providerId', v)}
          options={providers.map((p) => ({ value: p.id, label: p.name, description: p.identifier }))}
          error={errors.providerId}
        />
        <Input
          label="Provider model id"
          required
          readOnly={!!model}
          className="claw-mono"
          description={model ? `Public reference: ${model.ref}` : undefined}
          endAdornment={<FieldHelp label="Provider model id">Exactly as the provider names it, e.g. gpt-4o-mini or llama3.1:8b. Clients call it as provider/id, its public reference.</FieldHelp>}
          value={values.providerModelId}
          onChange={(ev) => set('providerModelId', ev.target.value)}
          error={errors.providerModelId}
        />
        <Input label="Display name" placeholder={values.providerModelId || undefined} value={values.displayName} onChange={(ev) => set('displayName', ev.target.value)} error={errors.displayName} />
        <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(9rem, 1fr))', gap: 'var(--eui-space-1, 0.25rem)' }}>
          <legend><Text as="strong" size="sm">Capabilities</Text></legend>
          {CAPABILITIES.map((c) => (
            <Checkbox key={c} label={CAPABILITY_LABEL[c]} checked={values.capabilities.includes(c)} onChange={(on) => toggleCap(c, on)} />
          ))}
        </fieldset>
        {errors.capabilities && <Text tone="error" size="sm">{errors.capabilities}</Text>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))', gap: 'var(--eui-space-3, 0.75rem)' }}>
          <NumberInput label="Context length" unit="tokens" min={1} step={1024} value={values.contextLength} onChange={(n) => set('contextLength', n)} error={errors.contextLength} />
          <NumberInput label="Max output" unit="tokens" min={1} step={1024} value={values.maxOutputTokens} onChange={(n) => set('maxOutputTokens', n)} error={errors.maxOutputTokens} />
          <WithFieldHelp label="Input price" help={PRICE_HELP}>
            <NumberInput label="Input price" unit="$ / 1M" min={0} step={0.05} precision={4} readOnly={values.followPrice} value={values.inputPrice} onChange={(n) => set('inputPrice', n)} error={errors.inputPrice} />
          </WithFieldHelp>
          <WithFieldHelp label="Output price" help={PRICE_HELP}>
            <NumberInput label="Output price" unit="$ / 1M" min={0} step={0.05} precision={4} readOnly={values.followPrice} value={values.outputPrice} onChange={(n) => set('outputPrice', n)} error={errors.outputPrice} />
          </WithFieldHelp>
        </div>
        {(model?.costSource === 'PROVIDER' || PUBLISHES_PRICES.has(providers.find((p) => p.id === values.providerId)?.kind ?? '')) && (
          <WithFieldHelp label="Use the provider's published price" help="On: the price comes from the provider's model list and is updated at every health check and connection test (recorded in the audit log). Off: the price above is kept as you set it.">
            <Switch label="Use the provider's published price" checked={values.followPrice} onChange={(on) => set('followPrice', on)}
              description={values.followPrice ? (model?.costSource === 'PROVIDER' ? 'Updated automatically.' : 'Filled in at the next health check or connection test.') : undefined} />
          </WithFieldHelp>
        )}
        <KeyLifetimeField
          value={values.maxKeyLifetimeHours}
          onChange={(h) => set('maxKeyLifetimeHours', h)}
          error={errors.maxKeyLifetimeHours}
          description={providerLimit ? `Optional. The provider allows at most ${formatLifetime(providerLimit)}.` : 'Optional. Blank: no limit of its own.'}
          help="API keys that use this model must expire within it, and older keys stop working with it. When the provider also sets a limit, the stricter one applies."
        />
        <Switch label="Enabled" checked={values.enabled} onChange={(on) => set('enabled', on)} />
      </Form>
    </Dialog>
  );
}
