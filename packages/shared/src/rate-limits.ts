/*
 * ClawRouter - Self-hosted AI gateway and control platform
 * https://github.com/iant89/ClawRouter
 *
 * Copyright (C) 2026 Ian Thomas
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * in the LICENSE file for more details.
 */

/**
 * Rate limiting vocabulary (spec §12). A limit counts requests and tokens over a
 * sliding window of one second, minute or hour; `null` means "no limit" for that
 * measure. A token bucket can be added on top to stop bursts (spamming).
 */
export const RATE_WINDOWS = ['second', 'minute', 'hour'] as const;
export type RateWindow = (typeof RATE_WINDOWS)[number];

export const RATE_WINDOW_MS: Record<RateWindow, number> = { second: 1_000, minute: 60_000, hour: 3_600_000 };

/**
 * A token bucket for requests: it starts full, each request takes one, and every
 * `refillEverySeconds` it gets `refillAmount` back, never more than `capacity`.
 * `capacity` is the largest burst; the refill sets the sustained rate.
 */
export interface TokenBucket {
  /** Requests that can be made at once when the bucket is full. */
  capacity: number;
  /** Requests added back at each refill. */
  refillAmount: number;
  /** Seconds between refills. */
  refillEverySeconds: number;
}

export interface RateLimit {
  window: RateWindow;
  /** Requests per window. */
  requests: number | null;
  /** Provider-reported tokens (input + output) per window. Checked before a request, charged after it. */
  tokens: number | null;
  /** Optional burst control, in addition to the window. */
  bucket: TokenBucket | null;
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

/**
 * Cost limits (SEC-005): US dollars spent per calendar hour, day and month (UTC),
 * read from the stored hourly usage records. `null` means no limit for that period.
 */
export const COST_PERIODS = ['hour', 'day', 'month'] as const;
export type CostPeriod = (typeof COST_PERIODS)[number];

export interface CostLimit {
  hour: number | null;
  day: number | null;
  month: number | null;
}

export interface ModelCostLimit extends CostLimit {
  /** Model reference, `provider/model`. */
  model: string;
}

export interface ProviderCostLimit extends CostLimit {
  /** Provider identifier (the part before the `/` in model references). */
  provider: string;
}

export interface CostLimits {
  /** Every API key, each on its own. */
  perKey: CostLimit;
  /** All keys of one user, combined. */
  perUser: CostLimit;
  /** A model over its budget is skipped, like a rate-limited one. */
  perModel: ModelCostLimit[];
  /** A provider over its budget is skipped (all of its models). */
  perProvider: ProviderCostLimit[];
  global: CostLimit;
  /** A model whose estimated cost for this request (input estimate + maximum output) is higher is not used. */
  maxEstimatedCostPerRequest: number | null;
}

export const NO_COST_LIMIT: CostLimit = { hour: null, day: null, month: null };

export const DEFAULT_COST_LIMITS: CostLimits = {
  perKey: { ...NO_COST_LIMIT }, perUser: { ...NO_COST_LIMIT }, perModel: [], perProvider: [], global: { ...NO_COST_LIMIT }, maxEstimatedCostPerRequest: null,
};

/** Largest dollar amount accepted for a cost limit. */
export const COST_LIMIT_MAX = 1_000_000_000;

/**
 * Request resource limits (SEC-006 and the per-request controls of SEC-005).
 * Structural limits always apply; token, concurrency and stream limits are
 * optional (`null`: no limit).
 */
export interface RequestLimits {
  /** Request body size for /v1 (bytes). */
  maxRequestBytes: number;
  /** Nesting depth of the JSON body (objects and arrays). */
  maxJsonDepth: number;
  /** Messages in one chat request. */
  maxMessages: number;
  /** Content parts (text, images, audio, PDFs) across all messages. */
  maxContentParts: number;
  /** Tools offered in one request. */
  maxToolDefinitions: number;
  /** All tool definitions together, as JSON (bytes). */
  maxToolSchemaBytes: number;
  /** Images in one request (inline and URLs). */
  maxImages: number;
  /** One inline image, decoded (bytes). */
  maxImageBytes: number;
  /** Width or height of an inline image (pixels), read from its header. */
  maxImageDimension: number;
  /** Estimated input tokens (about four characters per token). */
  maxInputTokens: number | null;
  /** Output tokens: a larger `max_tokens` is lowered to this, a missing one set to it. */
  maxOutputTokens: number | null;
  /** Estimated input plus maximum output. */
  maxTokensPerRequest: number | null;
  /** Requests in progress at the same time for one API key. */
  maxConcurrentPerKey: number | null;
  /** Requests in progress at the same time for all keys of one user. */
  maxConcurrentPerUser: number | null;
  /** A stream is ended after this many seconds. */
  maxStreamSeconds: number | null;
}

export const DEFAULT_REQUEST_LIMITS: RequestLimits = {
  maxRequestBytes: 25 * 1024 * 1024,
  maxJsonDepth: 64,
  maxMessages: 2_000,
  maxContentParts: 10_000,
  maxToolDefinitions: 128,
  maxToolSchemaBytes: 1024 * 1024,
  maxImages: 50,
  maxImageBytes: 15 * 1024 * 1024,
  maxImageDimension: 8_192,
  maxInputTokens: null,
  maxOutputTokens: null,
  maxTokensPerRequest: null,
  maxConcurrentPerKey: null,
  maxConcurrentPerUser: null,
  maxStreamSeconds: 3_600,
};

/** Allowed range of each request limit (inclusive). */
export const REQUEST_LIMIT_RANGES: Record<keyof RequestLimits, { min: number; max: number; nullable: boolean }> = {
  maxRequestBytes: { min: 1024, max: 100 * 1024 * 1024, nullable: false },
  maxJsonDepth: { min: 4, max: 256, nullable: false },
  maxMessages: { min: 1, max: 10_000, nullable: false },
  maxContentParts: { min: 1, max: 100_000, nullable: false },
  maxToolDefinitions: { min: 1, max: 128, nullable: false },
  maxToolSchemaBytes: { min: 1024, max: 10 * 1024 * 1024, nullable: false },
  maxImages: { min: 0, max: 50, nullable: false },
  maxImageBytes: { min: 1024, max: 15 * 1024 * 1024, nullable: false },
  maxImageDimension: { min: 16, max: 100_000, nullable: false },
  maxInputTokens: { min: 1, max: 100_000_000, nullable: true },
  maxOutputTokens: { min: 1, max: 1_000_000, nullable: true },
  maxTokensPerRequest: { min: 2, max: 100_000_000, nullable: true },
  maxConcurrentPerKey: { min: 1, max: 1_000_000, nullable: true },
  maxConcurrentPerUser: { min: 1, max: 1_000_000, nullable: true },
  maxStreamSeconds: { min: 1, max: 86_400, nullable: true },
};


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
  /** Spending limits (SEC-005). */
  costLimits: CostLimits;
  /** Request size, structure, token, concurrency and stream limits (SEC-006). */
  requestLimits: RequestLimits;
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
export interface PutRateLimitsRequest extends Omit<RateLimitSettings, 'costLimits' | 'requestLimits'> {
  version: number;
  /** Left out (older clients, older export files): the current cost limits stay. */
  costLimits?: CostLimits;
  /** Left out: the current request limits stay. */
  requestLimits?: RequestLimits;
}

export const NO_RATE_LIMIT: RateLimit = { window: 'minute', requests: null, tokens: null, bucket: null };

export const DEFAULT_RATE_LIMITS: RateLimitSettings = {
  perKey: { window: 'minute', requests: 120, tokens: null, bucket: null },
  perUser: { ...NO_RATE_LIMIT },
  perModel: [],
  global: { ...NO_RATE_LIMIT, maxConcurrent: 100 },
  invalidKeysPerIp: 20,
  costLimits: structuredClone(DEFAULT_COST_LIMITS),
  requestLimits: { ...DEFAULT_REQUEST_LIMITS },
};

/** Largest value accepted for any limit. */
export const RATE_LIMIT_MAX = 1_000_000_000;
/** Largest token bucket, and the longest refill interval (one day). */
export const BUCKET_CAPACITY_MAX = 1_000_000;
export const BUCKET_REFILL_SECONDS_MAX = 86_400;

export const RATE_LIMIT_SCOPES = ['key', 'user', 'model', 'provider', 'global', 'ip'] as const;
export type RateLimitScope = (typeof RATE_LIMIT_SCOPES)[number];

/** One live counter, for GET /api/rate-limits/usage. */
export interface RateLimitUsageEntry {
  scope: RateLimitScope;
  /** Key id, user id, model reference, "global" or the IP address. */
  subject: string;
  /** Readable name: key name and prefix, username, model reference. */
  label: string;
  /** Requests and tokens in the limit's current window (a minute for `ip`). */
  requests: number;
  tokens: number;
  limit: RateLimit;
  /** Requests left in the token bucket, when the limit has one. */
  bucketAvailable?: number;
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
  /** The whole gateway, and each model and provider with a cost limit. Empty without recorded usage. */
  spending: CostSpendEntry[];
}


/** Money spent in the current UTC hour, day and month against a cost limit (GET /api/rate-limits/usage). */
export interface CostSpendEntry {
  scope: 'model' | 'provider' | 'global';
  /** Model reference, provider identifier, or "All requests". */
  label: string;
  spent: { hour: number; day: number; month: number };
  limit: CostLimit;
}
