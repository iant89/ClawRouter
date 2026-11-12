/**
 * Gateway request history and usage (spec §22, §23). Prompts and completions are
 * never stored: a request record holds only metadata, counts and outcomes.
 */
export const REQUEST_STATUSES = ['EXECUTING', 'STREAMING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
/** Statuses of requests that have ended. */
export const FINAL_REQUEST_STATUSES: readonly RequestStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'];

export const GATEWAY_ENDPOINTS = ['chat.completions', 'embeddings'] as const;
export type GatewayEndpoint = (typeof GATEWAY_ENDPOINTS)[number];

/** Where token counts came from (spec §23). */
export type UsageSource = 'provider' | 'estimated' | 'none';

/** One try on one model, in order. */
export interface RequestAttempt {
  modelRef: string;
  providerId: string;
  /** 'ok', 'skipped_rate_limit' (our model limit; no provider call), or the provider failure kind: timeout, server_error, rate_limited (the provider's 429), auth… */
  outcome: string;
  durationMs: number;
}

export interface RequestRecord {
  id: string;
  receivedAt: string;
  completedAt: string | null;
  status: RequestStatus;
  endpoint: GatewayEndpoint;
  stream: boolean;
  apiKey: { id: string; name: string; prefix: string } | null;
  user: { id: string; username: string } | null;
  /** What the client sent as `model`. */
  requestedModel: string;
  /** The model that answered (or was last tried). */
  modelRef: string | null;
  provider: { id: string; name: string } | null;
  durationMs: number | null;
  httpStatus: number | null;
  attempts: number;
  retries: number;
  failovers: number;
  /** Client-safe error code and message; never provider internals. */
  errorCode: string | null;
  errorMessage: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  usageSource: UsageSource;
  /** Estimated from the model's prices at the time; null when the model has no prices. */
  costUsd: number | null;
}

/** GET /api/requests/:id */
export interface RequestDetail extends RequestRecord {
  attemptLog: RequestAttempt[];
}

/** GET /api/requests filters. */
export interface RequestQuery {
  page?: number;
  pageSize?: number;
  status?: RequestStatus;
  apiKeyId?: string;
  /** Matches the requested model or the model that answered. */
  model?: string;
  providerId?: string;
  /** ISO date-times, inclusive start and exclusive end. */
  from?: string;
  to?: string;
  /** Only requests that failed, timed out or were cancelled. */
  problemsOnly?: boolean;
}

export const USAGE_GROUPS = ['model', 'provider', 'apiKey', 'user'] as const;
export type UsageGroup = (typeof USAGE_GROUPS)[number];

export interface UsageTotals {
  requests: number;
  /** Requests that did not complete (failed, timed out, cancelled). */
  errors: number;
  inputTokens: number;
  outputTokens: number;
  /** Tokens counted locally because the provider reported none. */
  estimatedTokens: number;
  costUsd: number;
  /** Requests whose model has no prices (their cost is unknown, not zero). */
  unpricedRequests: number;
  averageDurationMs: number | null;
}

export interface UsageBucket extends UsageTotals {
  /** Start of the bucket (ISO). */
  start: string;
}

export interface UsageBreakdownRow extends UsageTotals {
  key: string;
  label: string;
}

/** GET /api/usage?from&to&bucket&groupBy */
export interface UsageReport {
  from: string;
  to: string;
  bucket: 'hour' | 'day';
  totals: UsageTotals;
  series: UsageBucket[];
  groupBy: UsageGroup;
  breakdown: UsageBreakdownRow[];
}
