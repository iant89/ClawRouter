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
 * Gateway request history and usage (spec §22, §23). Prompts and completions are
 * never stored: a request record holds only metadata, counts and outcomes.
 */
export const REQUEST_STATUSES = ['EXECUTING', 'STREAMING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
/** Statuses of requests that have ended. */
export const FINAL_REQUEST_STATUSES: readonly RequestStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'];

export const GATEWAY_ENDPOINTS = ['chat.completions', 'responses', 'messages', 'embeddings'] as const;
export type GatewayEndpoint = (typeof GATEWAY_ENDPOINTS)[number];

/** Where token counts came from (spec §23). */
export type UsageSource = 'provider' | 'estimated' | 'none';

/** One try on one model, in order. */
export interface RequestAttempt {
  modelRef: string;
  providerId: string;
  /** 'ok', 'skipped_rate_limit' (our model limit; no provider call), or the provider failure kind: timeout, server_error, rate_limited (the provider's 429), auth (401), forbidden (403)… */
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
