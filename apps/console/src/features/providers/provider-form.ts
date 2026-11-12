import { IDENTIFIER_PATTERN, type ProviderInfo, type ProviderKind, type ProviderKindInfo } from '@clawapi/shared';

export interface ProviderFormValues {
  kind: ProviderKind;
  name: string;
  identifier: string;
  endpoint: string;
  priority: number;
  timeoutSeconds: number;
  enabled: boolean;
  /** Blank on edit means "keep the stored key". */
  apiKey: string;
}

export type ProviderFormErrors = Partial<Record<keyof ProviderFormValues, string>>;

/** "OpenAI Production" -> "openai-production" */
export function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
}

export function initialValues(kind: ProviderKindInfo | undefined, existing?: ProviderInfo): ProviderFormValues {
  if (existing) {
    return {
      kind: existing.kind, name: existing.name, identifier: existing.identifier, endpoint: existing.endpoint,
      priority: existing.priority, timeoutSeconds: Math.round(existing.timeoutMs / 1000), enabled: existing.enabled, apiKey: '',
    };
  }
  return { kind: kind?.kind ?? 'openai', name: '', identifier: '', endpoint: '', priority: 100, timeoutSeconds: 60, enabled: true, apiKey: '' };
}

/** Quick client-side checks; the server enforces the real rules (including the endpoint policy). */
export function validate(values: ProviderFormValues, kind: ProviderKindInfo | undefined, mode: 'create' | 'edit', hasStoredKey: boolean): ProviderFormErrors {
  const e: ProviderFormErrors = {};
  if (!values.name.trim()) e.name = 'Enter a name.';
  if (mode === 'create' && !IDENTIFIER_PATTERN.test(values.identifier)) e.identifier = 'Use 2–63 lowercase letters, digits or dashes.';
  if (kind?.endpointRequired && !values.endpoint.trim()) e.endpoint = 'This provider type needs an endpoint URL.';
  if (values.endpoint.trim() && !/^https?:\/\//i.test(values.endpoint.trim())) e.endpoint = 'Start with https:// (or http:// for a local server).';
  if (!Number.isInteger(values.priority) || values.priority < 0 || values.priority > 10_000) e.priority = 'Use a whole number from 0 to 10000.';
  if (!Number.isInteger(values.timeoutSeconds) || values.timeoutSeconds < 1 || values.timeoutSeconds > 600) e.timeoutSeconds = 'Use 1 to 600 seconds.';
  if (values.apiKey && /\s/.test(values.apiKey)) e.apiKey = 'API keys cannot contain spaces.';
  // A missing key is allowed: the provider can be saved now and the key added later.
  void mode; void hasStoredKey;
  return Object.fromEntries(Object.entries(e).filter(([, v]) => v)) as ProviderFormErrors;
}

/** Server field names -> form field names. */
export const SERVER_FIELD: Record<string, keyof ProviderFormValues> = {
  name: 'name', identifier: 'identifier', endpoint: 'endpoint', priority: 'priority', timeoutMs: 'timeoutSeconds', apiKey: 'apiKey', kind: 'kind',
};
