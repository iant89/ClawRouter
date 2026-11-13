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

/**
 * When a key stops working, resolved by the server when the key is created:
 * - `never`;
 * - `end_of_day`: at the next midnight in the given IANA time zone (the user's), a key for today only;
 * - `after`: a length of time from creation;
 * - `at`: a specific moment.
 */
export type KeyExpiry =
  | { type: 'never' }
  | { type: 'end_of_day'; timeZone: string }
  | { type: 'after'; hours: number }
  | { type: 'at'; at: string };

/** Longest `after` period: ten years. */
export const KEY_EXPIRY_MAX_HOURS = 24 * 3650;

/** POST /api/api-keys (and /api/me/api-keys without `rateLimit`) */
export interface CreateApiKeyRequest {
  name: string;
  allowedModels?: string[];
  /** ISO date-time, or null for no expiry. `expiry` is the richer alternative; send one or neither. */
  expiresAt?: string | null;
  expiry?: KeyExpiry;
  /** Own limits for this key; omit or null for the default. Administrators only. */
  rateLimit?: RateLimit | null;
}

/**
 * Key requests: a user who may not create keys asks for one. Users who can
 * create keys for others (`api_keys.write`) and share no role with the
 * requester are notified; one approves or denies. On approval the requester
 * creates the key themselves (the secret is shown only to them, once).
 */
export const KEY_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'DENIED', 'CANCELLED', 'FULFILLED'] as const;
export type KeyRequestStatus = (typeof KEY_REQUEST_STATUSES)[number];

export interface ApiKeyRequestInfo {
  id: string;
  name: string;
  /** Why the key is needed, in the requester's words. */
  purpose: string;
  allowedModels: string[];
  expiry: KeyExpiry;
  status: KeyRequestStatus;
  requestedBy: { id: string; username: string; displayName: string };
  createdAt: string;
  decidedBy: { id: string; username: string } | null;
  decidedAt: string | null;
  /** The approver's note, or the reason for a denial. */
  decisionNote: string | null;
  /** The key created from an approved request. */
  apiKeyId: string | null;
}

/** POST /api/me/api-key-requests */
export interface CreateKeyRequestBody {
  name: string;
  purpose: string;
  allowedModels?: string[];
  expiry?: KeyExpiry;
}

/** POST /api/api-key-requests/:id/approve. Omitted fields keep what was requested. */
export interface ApproveKeyRequestBody {
  allowedModels?: string[];
  expiry?: KeyExpiry;
  note?: string;
}

/** POST /api/api-key-requests/:id/deny */
export interface DenyKeyRequestBody {
  reason: string;
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
