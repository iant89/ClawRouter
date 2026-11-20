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

import { errors, type Logger } from '@clawrouter/core';
import type { ModelService } from '@clawrouter/models';
import type {
  GatewayEndpoint, ModelCost, RequestAttempt, RequestContent, RequestDetail, RequestLoggingMode, RequestQuery, RequestRecord, RequestStatus, UsageBucket, UsageGroup, UsageReport,
  UsageSource, UsageTotals,
} from '@clawrouter/shared';
import type { RequestRepository } from './repository.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The longest period one usage report may cover. */
export const MAX_USAGE_RANGE_DAYS = 400;

export interface RequestStart {
  id: string;
  endpoint: GatewayEndpoint;
  stream: boolean;
  apiKeyId: string;
  userId: string | null;
  requestedModel: string;
}

export interface RequestEnd {
  status: Exclude<RequestStatus, 'EXECUTING' | 'STREAMING'>;
  httpStatus: number;
  durationMs: number;
  modelRef: string | null;
  providerId: string | null;
  attempts: number;
  retries: number;
  failovers: number;
  attemptLog: RequestAttempt[];
  errorCode: string | null;
  errorMessage: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; source: UsageSource; costUsd?: number | null };
  /** The prompt and reply: stored only when request logging is Full (the gateway collects it only then). */
  content?: Omit<RequestContent, 'requestId' | 'storedAt'>;
}

/** A request being recorded. `finish` is idempotent: only the first call counts. */
export interface RequestHandle {
  /** True when this request's prompt and reply will be stored (request logging was Full when it began). */
  readonly keepsContent: boolean;
  streaming(): void;
  /** Returns what the request cost in US dollars (reported or estimated), or null when unpriced. */
  finish(end: RequestEnd): number | null;
}

/** Estimated cost from per-million-token prices; null when a needed price is missing. */
export function estimateCost(cost: ModelCost | null | undefined, inputTokens: number, outputTokens: number): number | null {
  if (!cost) return null;
  if (inputTokens > 0 && cost.inputPerMTok === null) return null;
  if (outputTokens > 0 && cost.outputPerMTok === null) return null;
  const usd = (inputTokens / 1e6) * (cost.inputPerMTok ?? 0) + (outputTokens / 1e6) * (cost.outputPerMTok ?? 0);
  return Math.round(usd * 1e8) / 1e8;
}

const hourOf = (t: number) => new Date(t - (t % HOUR)).toISOString();

export type RequestLogService = ReturnType<typeof createRequestLogService>;

/**
 * Request history and usage (spec §22, §23). The gateway reports each request's
 * start and end; this service prices it with the model's prices at that moment and
 * keeps hourly usage records that outlive the request detail. What else is kept
 * follows the request logging mode (SEC-009), read when each request begins:
 * NONE keeps no request row (usage records only: quotas and cost limits need them),
 * METADATA the row, FULL the row and the prompt and reply.
 */
export function createRequestLogService(options: {
  repo: RequestRepository;
  models: Pick<ModelService, 'resolveRef'>;
  log?: Logger;
  now?: () => Date;
  /** Days to keep request rows and usage records (0 keeps forever). */
  retention?: { requestDays: number; usageDays: number };
  /** The request logging mode, read when each request begins. METADATA when not given. */
  mode?: () => RequestLoggingMode;
}) {
  const { repo, models, log } = options;
  const now = options.now ?? (() => new Date());
  const retention = options.retention ?? { requestDays: 30, usageDays: 400 };
  const mode = options.mode ?? (() => 'METADATA' as const);

  /** Recording must never break a gateway request: failures are logged and swallowed. */
  const safely = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (error) {
      log?.error(`request log: ${what} failed`, { component: 'requests', error });
    }
  };

  return {
    begin(start: RequestStart): RequestHandle {
      const receivedAt = now();
      const m = mode();
      const keepsRow = m !== 'NONE';
      if (keepsRow) safely('insert', () => repo.insert({ ...start, receivedAt: receivedAt.toISOString(), status: 'EXECUTING' }));
      let done = false;
      return {
        keepsContent: m === 'FULL',
        streaming() {
          if (!done && keepsRow) safely('status', () => repo.setStatus(start.id, 'STREAMING'));
        },
        finish(end) {
          if (done) return null;
          done = true;
          const input = end.usage.inputTokens ?? 0;
          const output = end.usage.outputTokens ?? 0;
          const model = end.modelRef ? models.resolveRef(end.modelRef) : undefined;
          const counted = input + output > 0;
          // The provider's own charge when it reports one (OpenRouter); otherwise an estimate from the model's prices.
          const reportedCost = typeof end.usage.costUsd === 'number' && Number.isFinite(end.usage.costUsd) && end.usage.costUsd >= 0 ? end.usage.costUsd : null;
          const costUsd = reportedCost ?? (counted ? estimateCost(model?.cost, input, output) : null);
          const at = now();
          safely('finish', () => {
            if (keepsRow) repo.finish(start.id, {
              completedAt: at.toISOString(), status: end.status, httpStatus: end.httpStatus, modelRef: end.modelRef, providerId: end.providerId,
              durationMs: end.durationMs, attempts: end.attempts, retries: end.retries, failovers: end.failovers, attemptLog: end.attemptLog,
              errorCode: end.errorCode, errorMessage: end.errorMessage, inputTokens: end.usage.inputTokens, outputTokens: end.usage.outputTokens,
              usageSource: end.usage.source, costUsd,
            });
            repo.addUsage({
              hour: hourOf(receivedAt.getTime()), apiKeyId: start.apiKeyId, userId: start.userId,
              modelRef: end.modelRef ?? '', providerId: end.providerId ?? '',
              error: end.status !== 'COMPLETED', inputTokens: input, outputTokens: output,
              estimatedTokens: end.usage.source === 'estimated' ? input + output : 0,
              costUsd: costUsd ?? 0, unpriced: counted && costUsd === null, durationMs: end.durationMs,
            });
          });
          if (m === 'FULL' && end.content) safely('content', () => repo.storeContent(start.id, at.toISOString(), JSON.stringify(end.content)));
          return costUsd;
        },
      };
    },

    /** True when requests beginning now would have their prompt and reply stored. */
    storesContent(): boolean {
      return mode() === 'FULL';
    },

    /** The stored prompt and reply of a request (Full request logging). */
    content(id: string): RequestContent {
      const c = repo.getContent(id);
      if (!c) throw errors.notFound('No prompt or reply is stored for this request: request logging was not Full, or it is older than the retention period.');
      return c;
    },

    list(query: RequestQuery): { items: RequestRecord[]; total: number; page: number; pageSize: number } {
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 50;
      return { ...repo.list({ ...query, limit: pageSize, offset: (page - 1) * pageSize }), page, pageSize };
    },

    get(id: string): RequestDetail {
      const r = repo.get(id);
      if (!r) throw errors.notFound('Request not found. It may be older than the retention period.');
      return r;
    },

    /**
     * Usage between `from` and `to` (rounded out to whole hours), as totals, a time
     * series with empty buckets filled in, and a breakdown by model, provider, API
     * key or user. Buckets are UTC hours or days.
     */
    usage(q: { from?: string; to?: string; bucket?: 'hour' | 'day'; groupBy?: UsageGroup }): UsageReport {
      const end = q.to ? Date.parse(q.to) : now().getTime();
      const start = q.from ? Date.parse(q.from) : end - DAY;
      if (Number.isNaN(start) || Number.isNaN(end) || start >= end) throw errors.validation([{ path: 'from', message: 'must be an ISO date-time before "to"' }]);
      if (end - start > MAX_USAGE_RANGE_DAYS * DAY) throw errors.validation([{ path: 'from', message: `the period can be at most ${MAX_USAGE_RANGE_DAYS} days` }]);
      const bucket = q.bucket ?? (end - start <= 2 * DAY ? 'hour' : 'day');
      const size = bucket === 'hour' ? HOUR : DAY;
      // Without "to", the period ends now: always include the bucket in progress
      // (even exactly on a boundary), and by default cover the 24 hours up to it.
      const to = q.to ? Math.ceil(end / size) * size : Math.floor(end / size) * size + size;
      const from = q.from ? Math.floor(start / size) * size : Math.min(to - size, Math.floor((to - DAY) / size) * size);
      const range = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), bucket, groupBy: q.groupBy ?? 'model' } as const;
      if ((to - from) / size > 1000) throw errors.validation([{ path: 'bucket', message: 'too many buckets: use days for long periods' }]);

      const found = new Map(repo.usageSeries(range).map((b) => [b.start, b]));
      const empty: UsageTotals = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, estimatedTokens: 0, costUsd: 0, unpricedRequests: 0, averageDurationMs: null };
      const series: UsageBucket[] = [];
      for (let t = from; t < to; t += size) {
        const key = new Date(t).toISOString();
        series.push(found.get(key) ?? { ...empty, start: key });
      }
      return {
        ...range,
        totals: repo.usageTotals(range.from, range.to),
        series,
        breakdown: repo.usageBreakdown(range),
      };
    },

    /** US dollars recorded since `fromHour` (an ISO hour) for a key, user, model, provider or everything (cost limits). */
    spendSince(scope: 'key' | 'user' | 'model' | 'provider' | 'global', subject: string, fromHour: string): number {
      return repo.spendSince(scope, subject, fromHour);
    },

    /** A user's completed requests, tokens and estimated cost since `since` (hourly records: from the start of that hour). */
    userUsageSince(userId: string, since: Date): { requests: number; tokens: number; costUsd: number } {
      return repo.userUsageSince(userId, hourOf(since.getTime()));
    },

    /** Applies the retention periods. Returns what was deleted. */
    prune(): { requests: number; usageRecords: number } {
      const t = now().getTime();
      const requests = retention.requestDays > 0 ? repo.pruneRequests(new Date(t - retention.requestDays * DAY).toISOString()) : 0;
      const usageRecords = retention.usageDays > 0 ? repo.pruneUsage(new Date(t - retention.usageDays * DAY).toISOString()) : 0;
      if (requests || usageRecords) log?.info('request history pruned', { component: 'requests', requests, usageRecords });
      return { requests, usageRecords };
    },

    /** At startup: requests left in progress by a previous process can never finish. */
    recoverInterrupted(): number {
      const n = repo.markInterrupted(now().toISOString());
      if (n) log?.warn('requests interrupted by a restart marked as failed', { component: 'requests', count: n });
      return n;
    },
  };
}
