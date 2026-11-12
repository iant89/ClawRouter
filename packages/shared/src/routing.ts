import type { Capability, ProviderState } from './providers.ts';

/**
 * Routing vocabulary (spec §10, §11). The routing configuration is one
 * versioned document; the engine turns a request into an ordered plan.
 */
export const FAILOVER_POLICIES = ['NONE', 'RETRY_SAME_PROVIDER', 'FAILOVER_PROVIDER', 'RETRY_AND_FAILOVER'] as const;
export type FailoverPolicy = (typeof FAILOVER_POLICIES)[number];

/** Hard ceiling on attempts for one request, whatever the configuration says (no retry loops). */
export const MAX_ATTEMPTS_CEILING = 10;

export interface RoutingPolicy {
  failover: FailoverPolicy;
  /** Total attempts for one request, across all targets and retries (1..MAX_ATTEMPTS_CEILING). */
  maxAttempts: number;
  /** Extra attempts on the same target before moving on (RETRY_* policies only, 0..3). */
  retriesPerTarget: number;
}

export interface AliasTarget {
  /** Model reference `<provider identifier>/<provider model id>`. */
  modelRef: string;
  /** Lower is tried first. Targets with the same priority share traffic by weight. */
  priority: number;
  /** Relative share within its priority level (1..1000). */
  weight: number;
}

export interface ModelAlias {
  /** What clients send as `model`, e.g. "fast-code". No "/" (that would look like a model reference). */
  name: string;
  description: string;
  enabled: boolean;
  /** Models must have all of these. With no targets, any usable model that has them is eligible. */
  capabilities: Capability[];
  targets: AliasTarget[];
  /** Overrides the default policy for this alias. */
  policy: RoutingPolicy | null;
}

export interface RoutingConfig {
  /** Incremented on every save; PUT must send the version it edited (optimistic concurrency). */
  version: number;
  defaultPolicy: RoutingPolicy;
  aliases: ModelAlias[];
  updatedAt: string | null;
  updatedBy: string | null;
}

/** GET /api/routing: the config plus problems worth showing (dangling references, aliases with nothing usable). */
export interface RoutingConfigView extends RoutingConfig {
  problems: { alias: string; message: string }[];
}

export type PutRoutingRequest = Pick<RoutingConfig, 'version' | 'defaultPolicy' | 'aliases'>;

export type RouteResolution = 'alias' | 'model_ref' | 'model_id';

export interface RouteCandidate {
  modelId: string;
  modelRef: string;
  displayName: string;
  providerId: string;
  providerName: string;
  providerModelId: string;
  providerStatus: ProviderState;
  priority: number;
  weight: number;
  /** Recent failures recorded for this provider (gateway failure history). */
  recentFailures: number;
}

export interface RouteAttempt {
  /** Index into `candidates`. */
  candidate: number;
  /** 1 for the first try on this candidate, 2+ for retries. */
  try: number;
}

export interface RoutePlan {
  requested: string;
  resolvedAs: RouteResolution;
  alias: string | null;
  policy: RoutingPolicy;
  requiredCapabilities: Capability[];
  /** Eligible models in the order they will be tried. */
  candidates: RouteCandidate[];
  /** The concrete attempt sequence after applying the policy and the attempt ceiling. */
  attempts: RouteAttempt[];
  /** Models that were considered and left out, with the reason. */
  excluded: { modelRef: string; reason: string }[];
}

/** POST /api/routing/preview */
export interface RoutePreviewRequest {
  model: string;
  capabilities?: Capability[];
}

export const ALIAS_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = { failover: 'RETRY_AND_FAILOVER', maxAttempts: 3, retriesPerTarget: 1 };
