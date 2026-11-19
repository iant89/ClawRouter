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

export const NO_RATE_LIMIT: RateLimit = { window: 'minute', requests: null, tokens: null, bucket: null };

export const DEFAULT_RATE_LIMITS: RateLimitSettings = {
  perKey: { window: 'minute', requests: 120, tokens: null, bucket: null },
  perUser: { ...NO_RATE_LIMIT },
  perModel: [],
  global: { ...NO_RATE_LIMIT, maxConcurrent: 100 },
  invalidKeysPerIp: 20,
};

/** Largest value accepted for any limit. */
export const RATE_LIMIT_MAX = 1_000_000_000;
/** Largest token bucket, and the longest refill interval (one day). */
export const BUCKET_CAPACITY_MAX = 1_000_000;
export const BUCKET_REFILL_SECONDS_MAX = 86_400;

export const RATE_LIMIT_SCOPES = ['key', 'user', 'model', 'global', 'ip'] as const;
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
}
