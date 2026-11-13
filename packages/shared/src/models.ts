import type { Capability, ProviderKind, ProviderState } from './providers.ts';

/**
 * Model registry vocabulary (spec §9). Model availability is separate from
 * provider availability: a healthy provider can stop offering a model, and an
 * available model is unusable while its provider is offline.
 */
export const MODEL_AVAILABILITY = ['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN'] as const;
export type ModelAvailability = (typeof MODEL_AVAILABILITY)[number];

export type ModelSource = 'DISCOVERED' | 'MANUAL';

/** Prices per million tokens, entered by an administrator (no provider API publishes them). */
export interface ModelCost {
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  currency: 'USD';
}

export interface ModelInfo {
  id: string;
  /** Stable public reference: `<provider identifier>/<provider model id>`. */
  ref: string;
  providerId: string;
  providerModelId: string;
  displayName: string;
  capabilities: Capability[];
  contextLength: number | null;
  maxOutputTokens: number | null;
  enabled: boolean;
  availability: ModelAvailability;
  availabilityCheckedAt: string | null;
  source: ModelSource;
  cost: ModelCost | null;
  /** This model's own maximum API key lifetime (hours); null: none of its own. */
  maxKeyLifetimeHours: number | null;
  /** The limit that applies: the stricter of the model's and its provider's, or null. */
  keyLifetimeLimit: KeyLifetimeLimit | null;
  provider: { id: string; name: string; identifier: string; kind: ProviderKind; enabled: boolean; status: ProviderState };
  /** Enabled, offered by the provider, and the provider is enabled and reachable. */
  usable: boolean;
  /** Why it is not usable, for display. */
  unusableReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/providers/:id/models/discover */
export interface DiscoveredModelInfo {
  providerModelId: string;
  displayName: string | null;
  contextLength: number | null;
  maxOutputTokens: number | null;
  capabilities: Capability[];
  /** Already in the registry. */
  registered: boolean;
}

export interface CreateModelRequest {
  providerId: string;
  providerModelId: string;
  displayName?: string;
  capabilities?: Capability[];
  contextLength?: number | null;
  maxOutputTokens?: number | null;
  enabled?: boolean;
  cost?: { inputPerMTok: number | null; outputPerMTok: number | null } | null;
  /** Maximum API key lifetime for this model, in hours; null removes the model's own limit. */
  maxKeyLifetimeHours?: number | null;
}

export type UpdateModelRequest = Partial<Omit<CreateModelRequest, 'providerId' | 'providerModelId'>>;

/** POST /api/providers/:id/models/import */
export interface ImportModelsRequest {
  providerModelIds: string[];
}

export interface ImportModelsResult {
  imported: number;
  skipped: number;
  models: ModelInfo[];
}

export interface ModelQuery {
  page?: number;
  pageSize?: number;
  providerId?: string;
  capability?: Capability;
  q?: string;
  usableOnly?: boolean;
}

/** A maximum API key lifetime and where it was set. */
export interface KeyLifetimeLimit {
  hours: number;
  source: 'model' | 'provider';
}

/** The stricter of a model's and its provider's limits. */
export function effectiveKeyLifetime(modelHours: number | null, providerHours: number | null): KeyLifetimeLimit | null {
  if (modelHours === null && providerHours === null) return null;
  if (providerHours === null || (modelHours !== null && modelHours <= providerHours)) return { hours: modelHours!, source: 'model' };
  return { hours: providerHours, source: 'provider' };
}

/** "36 hours", "7 days". */
export function formatLifetime(hours: number): string {
  return hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hour${hours === 1 ? '' : 's'}`;
}
