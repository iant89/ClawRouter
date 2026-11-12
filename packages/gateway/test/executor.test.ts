import { describe, expect, test } from 'bun:test';
import { AppError } from '@clawrouter/core';
import { ProviderCallError } from '@clawrouter/providers';
import { FailureTracker } from '@clawrouter/routing';
import type { RouteCandidate, RoutePlan } from '@clawrouter/shared';
import { classify, runAttempts } from '../src/executor.ts';

const cand = (ref: string): RouteCandidate => ({
  modelId: ref, modelRef: ref, displayName: ref, providerId: ref.split('/')[0]!, providerName: ref, providerModelId: ref,
  providerStatus: 'HEALTHY', priority: 0, weight: 1, recentFailures: 0,
});

const plan = (attempts: [number, number][]): RoutePlan => ({
  requested: 'x', resolvedAs: 'alias', alias: 'x', policy: { failover: 'RETRY_AND_FAILOVER', maxAttempts: 10, retriesPerModel: 1 } as unknown as RoutePlan['policy'],
  requiredCapabilities: [], candidates: [cand('a/m'), cand('b/m')], attempts: attempts.map(([candidate, t]) => ({ candidate, try: t })), excluded: [],
});

const run = (p: RoutePlan, call: (c: RouteCandidate) => Promise<string>, signal = new AbortController().signal) => {
  const failures = new FailureTracker();
  return { failures, result: runAttempts(p, { signal, failures, call: (c) => call(c), backoffMs: 0 }) };
};

describe('classify', () => {
  test('transient failures retry, model failures move on, request errors stop', () => {
    expect(classify(new ProviderCallError('timeout', 't')).verdict).toBe('retry');
    expect(classify(new ProviderCallError('server_error', 's')).verdict).toBe('retry');
    expect(classify(new ProviderCallError('auth', 'a')).verdict).toBe('next-model');
    expect(classify(new ProviderCallError('bad_request', 'b'))).toMatchObject({ verdict: 'stop', countsAsFailure: false });
    expect(classify(new ProviderCallError('cancelled', 'c'))).toMatchObject({ verdict: 'stop', countsAsFailure: false });
  });
});

describe('runAttempts', () => {
  test('an auth failure skips the remaining retries of that model', async () => {
    const calls: string[] = [];
    const { result, failures } = run(plan([[0, 1], [0, 2], [1, 1]]), async (c) => {
      calls.push(c.modelRef);
      if (c.modelRef === 'a/m') throw new ProviderCallError('auth', 'bad key');
      return 'ok';
    });
    expect(await result).toMatchObject({ value: 'ok', attempts: 2, failovers: 1, retries: 0 });
    expect(calls).toEqual(['a/m', 'b/m']);
    expect(failures.count('a')).toBe(1);
    expect(failures.count('b')).toBe(0);
  });

  test('timeouts on every attempt end as PROVIDER_TIMEOUT', async () => {
    const { result } = run(plan([[0, 1], [1, 1]]), async () => { throw new ProviderCallError('timeout', 'slow'); });
    const error = await result.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('PROVIDER_TIMEOUT');
    expect((error as AppError).details).toEqual({ attempts: 2 });
  });

  test('a cancelled request makes no further attempts', async () => {
    const controller = new AbortController();
    let calls = 0;
    const { result } = run(plan([[0, 1], [1, 1]]), async () => {
      calls += 1;
      controller.abort();
      throw new ProviderCallError('server_error', 'x');
    }, controller.signal);
    await expect(result).rejects.toMatchObject({ failure: 'cancelled' });
    expect(calls).toBe(1);
  });
});
