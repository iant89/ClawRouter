import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Form, Input, MessageStrip, NumberInput, PasswordInput, Select, Switch, Text } from '@enterprise-ui/react';
import type { ProviderInfo, ProviderKindInfo } from '@clawapi/shared';
import { ApiClientError } from '../../services/api-client.ts';
import { createProvider, removeProviderKey, updateProvider } from '../../services/providers.ts';
import { initialValues, SERVER_FIELD, slugify, validate, type ProviderFormErrors, type ProviderFormValues } from './provider-form.ts';

export interface ProviderDialogProps {
  open: boolean;
  /** Present when editing. */
  provider: ProviderInfo | null;
  kinds: ProviderKindInfo[];
  onClose: () => void;
  onSaved: (provider: ProviderInfo, created: boolean, keyProvided: boolean) => void;
}

/** Create or edit a provider. The API key is write-only: it is sent, never shown. */
export function ProviderDialog({ open, provider, kinds, onClose, onSaved }: ProviderDialogProps) {
  const mode = provider ? 'edit' : 'create';
  const [values, setValues] = useState<ProviderFormValues>(() => initialValues(kinds[0], provider ?? undefined));
  const [errors, setErrors] = useState<ProviderFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [identifierTouched, setIdentifierTouched] = useState(false);
  const kind = useMemo(() => kinds.find((k) => k.kind === values.kind), [kinds, values.kind]);

  useEffect(() => {
    if (!open) return;
    setValues(initialValues(kinds[0], provider ?? undefined));
    setErrors({});
    setFormError(null);
    setIdentifierTouched(!!provider);
  }, [open, provider, kinds]);

  const set = <K extends keyof ProviderFormValues>(key: K, value: ProviderFormValues[K]) => setValues((v) => ({ ...v, [key]: value }));

  const submit = async () => {
    const found = validate(values, kind, mode, !!provider?.credential.configured);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length) return;
    setSaving(true);
    try {
      const common = {
        name: values.name.trim(),
        endpoint: values.endpoint.trim() || undefined,
        priority: values.priority,
        timeoutMs: values.timeoutSeconds * 1000,
        enabled: values.enabled,
      };
      const saved = provider
        ? await updateProvider(provider.id, { ...common, ...(values.apiKey ? { apiKey: values.apiKey } : {}) })
        : await createProvider({ ...common, kind: values.kind, identifier: values.identifier, ...(values.apiKey ? { apiKey: values.apiKey } : {}) });
      onSaved(saved, !provider, !!values.apiKey);
    } catch (err) {
      if (err instanceof ApiClientError && err.issues.length) {
        const mapped: ProviderFormErrors = {};
        for (const issue of err.issues) {
          const field = SERVER_FIELD[issue.path];
          if (field) mapped[field] = `${issue.message.charAt(0).toUpperCase()}${issue.message.slice(1)}.`;
        }
        setErrors(mapped);
        if (!Object.keys(mapped).length || err.message !== 'The request is invalid.') setFormError(err.message);
      } else {
        setFormError(err instanceof Error ? err.message : 'Could not save the provider.');
      }
    } finally {
      setSaving(false);
    }
  };

  const removeKey = async () => {
    if (!provider) return;
    setSaving(true);
    try {
      onSaved(await removeProviderKey(provider.id), false, false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not remove the API key.');
    } finally {
      setSaving(false);
    }
  };

  const keyLabel = provider?.credential.configured ? 'Replace API key' : 'API key';
  const keyHelp = provider?.credential.configured
    ? `A key is stored${provider.credential.hint ? ` (ends in ${provider.credential.hint})` : ''}. Leave blank to keep it.`
    : kind?.apiKeyRequired ? 'Required to connect. Stored encrypted on the server and never shown again.' : 'Optional for this provider type.';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={provider ? `Edit ${provider.name}` : 'Add provider'}
      footer={
        <>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>{provider ? 'Save' : 'Add provider'}</Button>
          <Button variant="tertiary" onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <Form onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        {formError && <MessageStrip tone="error" announce="assertive">{formError}</MessageStrip>}
        <Select
          label="Provider type"
          required
          disabled={!!provider}
          value={values.kind}
          onChange={(v) => v && set('kind', v as ProviderFormValues['kind'])}
          options={kinds.map((k) => ({ value: k.kind, label: k.displayName, description: k.description }))}
          error={errors.kind}
        />
        <Input
          label="Name"
          required
          value={values.name}
          onChange={(e) => {
            const name = e.target.value;
            setValues((v) => ({ ...v, name, identifier: identifierTouched ? v.identifier : slugify(name) }));
          }}
          error={errors.name}
        />
        <Input
          label="Identifier"
          required
          readOnly={!!provider}
          className="claw-mono"
          description={provider ? 'Used by routing rules; cannot be changed.' : 'Used by routing rules. Lowercase letters, digits and dashes.'}
          value={values.identifier}
          onChange={(e) => {
            setIdentifierTouched(true);
            set('identifier', e.target.value);
          }}
          error={errors.identifier}
        />
        <Input
          label="Endpoint"
          required={!!kind?.endpointRequired}
          type="url"
          className="claw-mono"
          placeholder={kind?.defaultEndpoint ?? 'http://localhost:11434/v1'}
          description={kind?.defaultEndpoint ? `Leave blank for ${kind.defaultEndpoint}.` : 'Base URL of the OpenAI-compatible API, e.g. http://localhost:11434/v1 for Ollama.'}
          value={values.endpoint}
          onChange={(e) => set('endpoint', e.target.value)}
          error={errors.endpoint}
        />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))', gap: 'var(--eui-space-3, 0.75rem)' }}>
          <NumberInput label="Priority" description="Lower runs first." min={0} max={10_000} step={1} value={values.priority} onChange={(n) => set('priority', n ?? 0)} error={errors.priority} />
          <NumberInput label="Timeout" unit="s" min={1} max={600} step={1} value={values.timeoutSeconds} onChange={(n) => set('timeoutSeconds', n ?? 60)} error={errors.timeoutSeconds} />
        </div>
        {/* purpose="current": no strength meter, which means nothing for an API key. */}
        <PasswordInput
          label={keyLabel}
          purpose="current"
          autoComplete="off"
          spellCheck={false}
          description={keyHelp}
          value={values.apiKey}
          onChange={(e) => set('apiKey', e.target.value)}
          error={errors.apiKey}
        />
        {provider?.credential.configured && (
          <div>
            <Button size="sm" variant="tertiary" disabled={saving} onClick={() => void removeKey()}>Remove stored API key</Button>
          </div>
        )}
        <Switch label="Enabled" checked={values.enabled} onChange={(checked) => set('enabled', checked)} />
        {provider && <Text as="p" size="sm" tone="secondary">Moving the endpoint to a different host requires entering the API key again, so a stored key is never sent to a new host.</Text>}
      </Form>
    </Dialog>
  );
}
