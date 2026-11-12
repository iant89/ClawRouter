/** Provider vocabulary (spec §8, §9). Browser-safe; never carries credentials. */
export const PROVIDER_KINDS = ['openai', 'anthropic', 'google', 'openai_compatible'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const PROVIDER_STATES = ['UNKNOWN', 'HEALTHY', 'DEGRADED', 'OFFLINE', 'DISABLED'] as const;
export type ProviderState = (typeof PROVIDER_STATES)[number];

/** Model capabilities (spec §9). */
export const CAPABILITIES = ['CHAT', 'CODING', 'REASONING', 'VISION', 'EMBEDDINGS', 'TOOL_USE', 'RESEARCH'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** What a provider kind needs, for building forms. GET /api/providers/kinds */
export interface ProviderKindInfo {
  kind: ProviderKind;
  displayName: string;
  description: string;
  defaultEndpoint: string | null;
  endpointRequired: boolean;
  apiKeyRequired: boolean;
  capabilities: Capability[];
  supportsStreaming: boolean;
}

/** The stored credential, as the console may see it: never the value. */
export interface CredentialInfo {
  configured: boolean;
  /** Last 4 characters, to tell keys apart (e.g. "…abcd"). */
  hint: string | null;
  updatedAt: string | null;
}

export interface ProviderInfo {
  id: string;
  name: string;
  /** Stable slug used by routing rules, e.g. "openai-prod". */
  identifier: string;
  kind: ProviderKind;
  endpoint: string;
  enabled: boolean;
  priority: number;
  timeoutMs: number;
  status: ProviderState;
  statusDetail: string | null;
  statusCheckedAt: string | null;
  latencyMs: number | null;
  capabilities: Capability[];
  credential: CredentialInfo;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderCheck {
  checkedAt: string;
  kind: 'TEST' | 'HEALTH';
  status: ProviderState;
  latencyMs: number | null;
  detail: string | null;
}

export interface ProviderDetail extends ProviderInfo {
  recentChecks: ProviderCheck[];
}

/** POST /api/providers/:id/test */
export interface ConnectionTestResult {
  ok: boolean;
  status: ProviderState;
  latencyMs: number | null;
  message: string;
  /** Number of models the provider reported, when it lists them. */
  modelCount: number | null;
  /** A few model ids, as a sanity check. */
  sampleModels: string[];
  checkedAt: string;
}

export interface CreateProviderRequest {
  name: string;
  identifier: string;
  kind: ProviderKind;
  endpoint?: string;
  priority?: number;
  timeoutMs?: number;
  enabled?: boolean;
  /** Write-only. */
  apiKey?: string;
}

export interface UpdateProviderRequest {
  name?: string;
  endpoint?: string;
  priority?: number;
  timeoutMs?: number;
  enabled?: boolean;
}

export const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === 'string' && (PROVIDER_KINDS as readonly string[]).includes(value);
}
