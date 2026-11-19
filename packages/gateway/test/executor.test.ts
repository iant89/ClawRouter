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

import { describe, expect, test } from 'bun:test';
import { AppError } from '@clawrouter/core';
import { ProviderCallError, retryAfterSeconds } from '@clawrouter/providers';
import { FailureTracker } from '@clawrouter/routing';
import type { RouteCandidate, RoutePlan } from '@clawrouter/shared';
import { classify, rejectedMessage, runAttempts } from '../src/executor.ts';

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

describe('what clients are told when providers fail', () => {
  const failed = async (p: RoutePlan, call: (c: RouteCandidate) => Promise<string>) => (await run(p, call).result.catch((e: unknown) => e)) as AppError;

  test('every attempt rate limited: 429 with the shortest wait the providers asked for', async () => {
    const error = await failed(plan([[0, 1], [0, 2], [1, 1]]), async (c) => {
      throw new ProviderCallError('rate_limited', 'Rate limit reached in organization org_123', 429, undefined, c.modelRef === 'a/m' ? 30 : 12);
    });
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.status).toBe(429);
    expect(error.headers).toEqual({ 'Retry-After': '12' });
    expect(error.publicMessage).toBe('The model providers are rate limiting requests (3 attempts). Try again in 12 s.');
    expect(error.details).toEqual({ attempts: 3, code: 'provider_rate_limited' });
  });

  test('rate limited without a Retry-After: 429 without the header', async () => {
    const error = await failed(plan([[0, 1]]), async () => { throw new ProviderCallError('rate_limited', 'slow down', 429); });
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.headers).toEqual({});
    expect(error.publicMessage).toContain('Try again shortly.');
  });

  test('rate limited on one model, a server error on the other: still a provider error (502)', async () => {
    const error = await failed(plan([[0, 1], [1, 1]]), async (c) => {
      throw c.modelRef === 'a/m' ? new ProviderCallError('rate_limited', 'x', 429) : new ProviderCallError('server_error', 'y', 500);
    });
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.status).toBe(502);
  });

  test("a provider's 400 never reaches the client in the provider's words", async () => {
    const groq = 'The provider rejected the request (HTTP 413): Request too large for model `qwen/qwen3-32b` in organization `org_01abc` service tier `on_demand` on input tokens per minute (ITPM): Limit 7000, Requested 7397. Upgrade to Dev Tier today at https://console.groq.com/settings/billing';
    const error = await failed(plan([[0, 1], [1, 1]]), async () => { throw new ProviderCallError('bad_request', groq, 413); });
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.publicMessage).toStartWith('The request is too large for the model');
    for (const leak of ['org_01abc', 'groq', 'Upgrade', 'on_demand']) expect(error.publicMessage).not.toContain(leak);
    expect(rejectedMessage('The provider rejected the request (HTTP 400): Invalid schema for function get_weather in project proj_9')).toBe(
      "The model provider rejected the request as invalid. An administrator can find the provider's explanation in ClawRouter's logs for this request.",
    );
  });

  test('Retry-After: seconds or an HTTP date, capped at an hour', () => {
    const now = Date.parse('2026-11-19T00:00:00Z');
    expect(retryAfterSeconds('7', now)).toBe(7);
    expect(retryAfterSeconds('2.2', now)).toBe(3);
    expect(retryAfterSeconds('Thu, 19 Nov 2026 00:01:30 GMT', now)).toBe(90);
    expect(retryAfterSeconds('99999', now)).toBe(3600);
    expect(retryAfterSeconds('soon', now)).toBeNull();
    expect(retryAfterSeconds(null, now)).toBeNull();
  });
});
