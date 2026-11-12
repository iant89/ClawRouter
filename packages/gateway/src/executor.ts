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
 *   - retry: transient (timeout, network, 5xx, 429, garbled response); the same model may work;
 *   - next-model: this model cannot work (credentials, not found, misconfigured); skip its retries;
 *   - stop: the request itself is at fault (400) or was cancelled; trying elsewhere would not help.
 */
export function classify(error: unknown): { verdict: Verdict; countsAsFailure: boolean; kind: string } {
  if (error instanceof ProviderCallError) {
    switch (error.failure) {
      case 'cancelled':
        return { verdict: 'stop', countsAsFailure: false, kind: 'cancelled' };
      case 'bad_request':
        return { verdict: 'stop', countsAsFailure: false, kind: 'bad_request' };
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

export const cancelled = () => new ProviderCallError('cancelled', 'The request was cancelled.');

/** A model refused by its rate limit before any provider call. */
export interface ModelLimitDenial {
  retryAfterMs: number;
  kind: 'requests' | 'tokens';
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
    if (attempt.try > 1) await pause(Math.min(backoff * (attempt.try - 1), 2_000), signal);
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
          // The provider's own explanation (already scrubbed of credentials) helps the client fix the request.
          throw new AppError('VALIDATION_ERROR', error.message.replace(/^The provider rejected the request \(HTTP \d+\)(: )?/, '') || 'The provider rejected the request.', { details: { param: null } });
        }
        throw error;
      }
      if (verdict === 'next-model') skipped.add(attempt.candidate);
      last = { kind, error };
    }
  }

  if (made === 0 && limited) throw new ModelsRateLimitedError(limited.modelRef, limited.denial);
  const n = made;
  if (last?.kind === 'timeout') {
    throw new AppError('PROVIDER_TIMEOUT', `The model provider did not respond in time (${n} attempt${n === 1 ? '' : 's'}).`, { expose: true, details: { attempts: n } });
  }
  throw new AppError('PROVIDER_ERROR', `The model providers could not complete the request (${n} attempt${n === 1 ? '' : 's'}; last error: ${last?.kind ?? 'none'}).`, {
    expose: true, details: { attempts: n },
  });
}
