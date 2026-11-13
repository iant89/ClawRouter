import type { RateLimit } from './rate-limits.ts';

/**
 * Gateway vocabulary (spec §6, §7, §14). API keys authenticate external AI
 * clients on /v1/*; they are separate from console sessions.
 */
/** SUSPENDED: the user who owns the key is disabled; it works again if they are re-enabled. */
export const API_KEY_STATUSES = ['ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED'] as const;
export type ApiKeyStatus = (typeof API_KEY_STATUSES)[number];

/** Every key starts with this, so leaked keys are easy to recognize (e.g. by secret scanners). */
export const API_KEY_PREFIX = 'crk_';

export interface ApiKeyInfo {
  id: string;
  name: string;
  /** Public part shown in lists, e.g. "crk_3f9a1c2b". The secret part is never shown again. */
  prefix: string;
  /** Model names this key may request (aliases, references or model ids). Empty: any model. */
  allowedModels: string[];
  status: ApiKeyStatus;
  createdAt: string;
  createdBy: { id: string; username: string } | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** This key's own limits; null uses the default per-key limit. */
  rateLimit: RateLimit | null;
}

/** POST /api/api-keys */
export interface CreateApiKeyRequest {
  name: string;
  allowedModels?: string[];
  /** ISO date-time, or null for no expiry. */
  expiresAt?: string | null;
  /** Own limits for this key; omit or null for the default. */
  rateLimit?: RateLimit | null;
}

/** PATCH /api/api-keys/:id */
export interface UpdateApiKeyRequest {
  name?: string;
  allowedModels?: string[];
  rateLimit?: RateLimit | null;
}

/** The only response that ever contains the full key. */
export interface CreatedApiKey {
  key: ApiKeyInfo;
  secret: string;
}

/** GET /api/gateway/metrics: in-memory, since the server started (persistent history is phase 10). */
export interface GatewayMetrics {
  startedAt: string;
  activeRequests: number;
  totalRequests: number;
  totalErrors: number;
  requestsLastMinute: number;
  errorsLastMinute: number;
  /** Mean over the last 100 completed requests, or null before the first. */
  averageLatencyMs: number | null;
  /** Provider-reported tokens over the last hour. */
  tokensLastHour: { input: number; output: number };
  /** Requests that needed a retry or a failover, since start. */
  retriedRequests: number;
  failedOverRequests: number;
  /** Requests refused with 429 (any limit). */
  rateLimitedLastMinute: number;
  rateLimitedTotal: number;
}
