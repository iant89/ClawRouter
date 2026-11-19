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

import { AppError, type Logger } from '@clawrouter/core';
import { ProviderCallError } from '@clawrouter/providers';
import type { FailureTracker } from '@clawrouter/routing';
import type { RequestAttempt, RouteCandidate, RoutePlan } from '@clawrouter/shared';

/**
 * Executes a route plan (spec §6 steps 9–12, §11): tries the plan's attempts in
 * order until one succeeds, retrying and failing over as the plan says. The plan
 * already caps the attempt count, so this loop always ends.
 */
export interface AttemptOutcome<T> {
  value: T;
  candidate: RouteCandidate;
  /** Attempts made, including the successful one. */
  attempts: number;
  /** Distinct models tried minus one. */
  failovers: number;
  retries: number;
}

type Verdict = 'retry' | 'next-model' | 'stop';

/**
 * What a failed attempt means:
 *   - retry: transient (timeout, network, 5xx, garbled response); the same model may work;
 *   - next-model: this model cannot work (credentials, not found, misconfigured); skip its retries;
 *   - stop: the request itself is at fault (400) or was cancelled; trying elsewhere would not help.
 *
 * A provider's 429 is retried only when the provider asks for a short wait (Retry-After up to
 * RETRY_AFTER_LIMIT_S); otherwise the next model is tried. Asking again a quarter of a second
 * later rarely helps, and on metered free tiers (OpenRouter counts free-model requests per day)
 * every retry is spent from the account's allowance.
 *
 * A 403 (`forbidden`) is the provider refusing this key this model (a model offered only to some
 * apps, a spent credit limit on paid models): the next model is tried, but it does not count as a
 * provider failure, because the provider's other models on the same key keep working.
 */
export const RETRY_AFTER_LIMIT_S = 2;

export function classify(error: unknown): { verdict: Verdict; countsAsFailure: boolean; kind: string } {
  if (error instanceof ProviderCallError) {
    switch (error.failure) {
      case 'cancelled':
        return { verdict: 'stop', countsAsFailure: false, kind: 'cancelled' };
      case 'bad_request':
        return { verdict: 'stop', countsAsFailure: false, kind: 'bad_request' };
      case 'forbidden':
        return { verdict: 'next-model', countsAsFailure: false, kind: 'forbidden' };
      // Refused by the outbound network policy: no call was made, and none would succeed.
      case 'blocked':
        return { verdict: 'next-model', countsAsFailure: false, kind: 'blocked' };
      case 'rate_limited': {
        const wait = error.retryAfterSeconds;
        return { verdict: wait !== null && wait <= RETRY_AFTER_LIMIT_S ? 'retry' : 'next-model', countsAsFailure: true, kind: 'rate_limited' };
      }
      case 'auth':
      case 'not_found':
        return { verdict: 'next-model', countsAsFailure: true, kind: error.failure };
      default:
        return { verdict: 'retry', countsAsFailure: true, kind: error.failure };
    }
  }
  if (error instanceof AppError && (error.code === 'ROUTING_ERROR' || error.code === 'PROVIDER_ERROR')) {
    return { verdict: 'next-model', countsAsFailure: false, kind: 'unavailable' };
  }
  return { verdict: 'next-model', countsAsFailure: true, kind: 'internal' };
}

/** Waits `ms`, or rejects when the request is cancelled. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(cancelled());
    }, { once: true });
  });
}

/**
 * What a client is told when a provider refuses a request as invalid. Never the
 * provider's own text: it can name the provider account (organization ids, tiers,
 * upgrade links) and is written for the provider's customer, not ours. The full
 * text stays in ClawRouter's logs under the request id (attempt failures are
 * logged), where administrators and operators can read it.
 */
export function rejectedMessage(providerText: string): string {
  if (/too large|too long|context.length|context window|maximum context|too many (input )?tokens|tokens per minute|reduce (the|your) (message|prompt|input)/i.test(providerText)) {
    return 'The request is too large for the model: it has more tokens than the model or its provider allows. Shorten the conversation or the request, or choose a model with a larger context.';
  }
  return 'The model provider rejected the request as invalid. An administrator can find the provider\'s explanation in ClawRouter\'s logs for this request.';
}

export const cancelled = () => new ProviderCallError('cancelled', 'The request was cancelled.');

/** A model refused by its rate limit before any provider call. */
export interface ModelLimitDenial {
  retryAfterMs: number;
  /** `cost`: the model or its provider is over a spending limit (SEC-005). */
  kind: 'requests' | 'tokens' | 'burst' | 'cost';
  window: 'second' | 'minute' | 'hour';
  cost?: unknown;
  bucket?: { capacity: number; refillAmount: number; refillEverySeconds: number } | null;
  limit: number;
}

/** Thrown when every candidate model was skipped because of its rate limit. */
export class ModelsRateLimitedError extends Error {
  constructor(readonly modelRef: string, readonly denial: ModelLimitDenial) {
    super(`Every model for this request is at its rate limit (${modelRef}).`);
  }
}

export async function runAttempts<T>(
  plan: RoutePlan,
  options: {
    signal: AbortSignal;
    failures: FailureTracker;
    call: (candidate: RouteCandidate, signal: AbortSignal) => Promise<T>;
    log?: Logger;
    /** Checks a model's rate limit before it is tried; a denied model is skipped without calling the provider. */
    checkModel?: (candidate: RouteCandidate) => Promise<ModelLimitDenial | null>;
    /** Receives one entry per attempt (and per model skipped for its rate limit), for request history. */
    trace?: RequestAttempt[];
    /** Delay before a retry of the same model, times the try number (ms). */
    backoffMs?: number;
  },
): Promise<AttemptOutcome<T>> {
  const { signal, failures, call, log } = options;
  const backoff = options.backoffMs ?? 250;
  const skipped = new Set<number>();
  const tried = new Set<number>();
  let made = 0;
  let last: { kind: string; error: unknown } | null = null;
  /** Kinds of failed provider attempts, and the shortest wait a rate-limiting provider asked for. */
  const kinds = new Set<string>();
  let providerWait: number | null = null;
  /** The wait a rate-limiting provider asked for before retrying the same model (ms). */
  let askedWaitMs = 0;
  let limited: { modelRef: string; denial: ModelLimitDenial } | null = null;

  for (const attempt of plan.attempts) {
    if (skipped.has(attempt.candidate)) continue;
    if (signal.aborted) throw cancelled();
    const candidate = plan.candidates[attempt.candidate]!;
    const denial = options.checkModel ? await options.checkModel(candidate) : null;
    if (denial) {
      skipped.add(attempt.candidate);
      if (!limited || denial.retryAfterMs < limited.denial.retryAfterMs) limited = { modelRef: candidate.modelRef, denial };
      options.trace?.push({ modelRef: candidate.modelRef, providerId: candidate.providerId, outcome: 'skipped_rate_limit', durationMs: 0 });
      log?.info('model skipped: rate limit', { component: 'gateway', model: candidate.modelRef, kind: denial.kind });
      continue;
    }
    // A retry waits its backoff, or the provider's Retry-After when that is longer (at most RETRY_AFTER_LIMIT_S).
    if (attempt.try > 1) await pause(Math.max(Math.min(backoff * (attempt.try - 1), 2_000), askedWaitMs), signal);
    askedWaitMs = 0;
    made += 1;
    tried.add(attempt.candidate);
    try {
      const t0 = performance.now();
      const took = () => Math.round(performance.now() - t0);
      const value = await call(candidate, signal).catch((error: unknown) => {
        options.trace?.push({ modelRef: candidate.modelRef, providerId: candidate.providerId, outcome: classify(error).kind, durationMs: took() });
        throw error;
      });
      options.trace?.push({ modelRef: candidate.modelRef, providerId: candidate.providerId, outcome: 'ok', durationMs: took() });
      failures.recordSuccess(candidate.providerId);
      return { value, candidate, attempts: made, failovers: tried.size - 1, retries: made - tried.size };
    } catch (error) {
      const { verdict, countsAsFailure, kind } = classify(error);
      if (countsAsFailure) failures.recordFailure(candidate.providerId);
      log?.info('gateway attempt failed', {
        component: 'gateway', model: candidate.modelRef, providerId: candidate.providerId, try: attempt.try, kind,
        error: error instanceof Error ? error.message : String(error),
      });
      if (verdict === 'stop') {
        if (kind === 'bad_request' && error instanceof ProviderCallError) {
          throw new AppError('VALIDATION_ERROR', rejectedMessage(error.message), { expose: true, details: { param: null } });
        }
        throw error;
      }
      if (verdict === 'next-model') skipped.add(attempt.candidate);
      last = { kind, error };
      kinds.add(kind);
      if (kind === 'rate_limited' && error instanceof ProviderCallError && error.retryAfterSeconds !== null) {
        providerWait = providerWait === null ? error.retryAfterSeconds : Math.min(providerWait, error.retryAfterSeconds);
        if (verdict === 'retry') askedWaitMs = error.retryAfterSeconds * 1000;
      }
    }
  }

  if (made === 0 && limited) throw new ModelsRateLimitedError(limited.modelRef, limited.denial);
  const n = made;
  if (last?.kind === 'timeout') {
    throw new AppError('PROVIDER_TIMEOUT', `The model provider did not respond in time (${n} attempt${n === 1 ? '' : 's'}).`, { expose: true, details: { attempts: n } });
  }
  // Every provider asked us to slow down: the client should too (429, not 502), after the provider's own wait when it gave one.
  if (n > 0 && kinds.size === 1 && kinds.has('rate_limited')) {
    throw new AppError('RATE_LIMITED', `The model providers are rate limiting requests (${n} attempt${n === 1 ? '' : 's'}). Try again ${providerWait !== null ? `in ${providerWait} s` : 'shortly'}.`, {
      expose: true, details: { attempts: n, code: 'provider_rate_limited' }, headers: providerWait !== null ? { 'Retry-After': String(providerWait) } : {},
    });
  }
  // A model the provider no longer has. The provider's explanation (often naming a replacement) is in the logs, not here.
  const missing = last?.kind === 'not_found'
    ? ' The model may have been retired by its provider; an administrator can find the provider\'s explanation in ClawRouter\'s logs for this request.'
    : last?.kind === 'forbidden'
      ? ' The provider does not allow this model to be used with ClawRouter\'s key; an administrator can find the provider\'s explanation in ClawRouter\'s logs for this request.'
      : '';
  throw new AppError('PROVIDER_ERROR', `The model providers could not complete the request (${n} attempt${n === 1 ? '' : 's'}; last error: ${last?.kind ?? 'none'}).${missing}`, {
    expose: true, details: { attempts: n },
  });
}
