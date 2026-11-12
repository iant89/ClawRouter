/**
 * Rate limiting vocabulary (spec §12). Limits are per minute, over a sliding
 * window. `null` means "no limit" for that measure.
 */
export interface RateLimit {
  requestsPerMinute: number | null;
  /** Provider-reported tokens (input + output). Checked before a request, charged after it. */
  tokensPerMinute: number | null;
}

/** A limit on one model, usually to stay inside a provider's own quota. */
export interface ModelRateLimit extends RateLimit {
  /** Model reference, `provider/model`. */
  model: string;
}

export interface GlobalRateLimit extends RateLimit {
  /** Requests being processed at the same time, across all keys. */
  maxConcurrent: number | null;
}

export interface RateLimitSettings {
  /** Applies to every API key that has no limit of its own. */
  perKey: RateLimit;
  /** All keys created by the same user, combined. */
  perUser: RateLimit;
  /** Applied when a model is tried; a limited model is skipped like a failed one. */
  perModel: ModelRateLimit[];
  global: GlobalRateLimit;
  /** Failed API-key authentications allowed per client IP per minute before it is blocked. */
  invalidKeysPerIp: number;
}

export interface RateLimitConfig extends RateLimitSettings {
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** GET /api/rate-limits */
export interface RateLimitConfigView extends RateLimitConfig {
  /** Model limits naming models that are no longer registered (they never apply). */
  unknownModels: string[];
}

/** PUT /api/rate-limits */
export interface PutRateLimitsRequest extends RateLimitSettings {
  version: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitSettings = {
  perKey: { requestsPerMinute: 120, tokensPerMinute: null },
  perUser: { requestsPerMinute: null, tokensPerMinute: null },
  perModel: [],
  global: { requestsPerMinute: null, tokensPerMinute: null, maxConcurrent: 100 },
  invalidKeysPerIp: 20,
};

/** Largest value accepted for any limit. */
export const RATE_LIMIT_MAX = 1_000_000_000;

export const RATE_LIMIT_SCOPES = ['key', 'user', 'model', 'global', 'ip'] as const;
export type RateLimitScope = (typeof RATE_LIMIT_SCOPES)[number];

/** One live counter, for GET /api/rate-limits/usage. */
export interface RateLimitUsageEntry {
  scope: RateLimitScope;
  /** Key id, user id, model reference, "global" or the IP address. */
  subject: string;
  /** Readable name: key name and prefix, username, model reference. */
  label: string;
  requestsLastMinute: number;
  tokensLastMinute: number;
  limit: RateLimit;
  /** For `global`: requests in progress. */
  concurrent?: number;
  /** For `ip`: blocked after too many invalid keys. */
  blocked?: boolean;
}

/** GET /api/rate-limits/usage */
export interface RateLimitUsage {
  entries: RateLimitUsageEntry[];
  /** Requests refused with 429 in the last minute and since the server started. */
  rejectedLastMinute: number;
  rejectedTotal: number;
}
