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

import { AppError } from '@clawrouter/core';
import { OutboundBlockedError } from '@clawrouter/security';
import type { ProviderCallContext } from './types.ts';
import { obj, type Json } from './untrusted.ts';

/** Why a provider call failed, in provider-independent terms. */
export type ProviderFailure = 'auth' | 'forbidden' | 'blocked' | 'rate_limited' | 'timeout' | 'unreachable' | 'bad_request' | 'not_found' | 'server_error' | 'invalid_response' | 'cancelled';

/**
 * A failed provider call. `message` is safe to show administrators: it never
 * contains the API key (scrubbed) and provider error text is truncated.
 */
export class ProviderCallError extends AppError {
  readonly failure: ProviderFailure;
  readonly httpStatus: number | null;
  /** From the provider's Retry-After header (429 and 503), in seconds; null when it sent none. */
  readonly retryAfterSeconds: number | null;

  constructor(failure: ProviderFailure, message: string, httpStatus: number | null = null, cause?: unknown, retryAfterSeconds: number | null = null) {
    super(failure === 'timeout' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR', message, { expose: true, cause });
    this.failure = failure;
    this.httpStatus = httpStatus;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Removes any occurrence of the secret from text that might be shown or logged. */
export function scrub(text: string, secret: string | null): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join('[REDACTED]');
}

async function errorText(response: Response, apiKey: string | null): Promise<string> {
  let detail = '';
  try {
    const raw = await response.text();
    try {
      // Google wraps its error in a list: [{ "error": { … } }].
      const parsed = JSON.parse(raw) as unknown;
      const body = (Array.isArray(parsed) ? parsed[0] ?? {} : parsed ?? {}) as { error?: { message?: unknown } | string; message?: unknown };
      const candidate = typeof body.error === 'object' ? body.error?.message : body.error ?? body.message;
      detail = typeof candidate === 'string' ? candidate : raw;
    } catch {
      detail = raw;
    }
  } catch {
    // ignore unreadable bodies
  }
  detail = scrub(detail.replace(/\s+/g, ' ').trim(), apiKey).slice(0, 300);
  return detail;
}

/** Retry-After as seconds (a number or an HTTP date), capped at an hour; null when absent or unreadable. */
export function retryAfterSeconds(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const seconds = /^\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : (Date.parse(trimmed) - now) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(Math.ceil(seconds), 3600);
}

function failureFor(status: number, detail = ''): ProviderFailure {
  if (status === 401) return 'auth';
  // Google answers a wrong API key with 400 "API key not valid" (reason API_KEY_INVALID).
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(detail)) return 'auth';
  // 403 is the provider refusing this key something (a model it may not use, a spent credit limit,
  // a model only offered to some apps), not a wrong key: other models on the same key still work.
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server_error';
  return 'bad_request';
}

const FAILURE_TEXT: Record<ProviderFailure, string> = {
  auth: 'The provider rejected the credentials',
  forbidden: 'The provider refused this key access',
  blocked: 'The provider endpoint is not allowed',
  rate_limited: 'The provider is rate limiting requests',
  timeout: 'The provider did not respond in time',
  unreachable: 'The provider could not be reached',
  bad_request: 'The provider rejected the request',
  not_found: 'The provider endpoint or model was not found',
  server_error: 'The provider returned a server error',
  invalid_response: 'The provider returned an unexpected response',
  cancelled: 'The request was cancelled',
};

/**
 * fetch with a timeout, caller cancellation and no redirects. Redirects are
 * refused because following one could send the API key to another host.
 * Non-2xx responses become ProviderCallError.
 */
export async function providerFetch(ctx: ProviderCallContext, url: string, init: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(ctx.timeoutMs);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
  const doFetch = ctx.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, { ...init, signal, redirect: 'manual' });
  } catch (error) {
    if (ctx.signal?.aborted) throw new ProviderCallError('cancelled', FAILURE_TEXT.cancelled, null, error);
    if (timeout.aborted) throw new ProviderCallError('timeout', `${FAILURE_TEXT.timeout} (${ctx.timeoutMs} ms)`, null, error);
    // The outbound network policy refused the destination (SEC-001): a configuration problem, never worth a retry.
    if (error instanceof OutboundBlockedError) throw new ProviderCallError('blocked', scrub(error.message, ctx.apiKey), null, error);
    const reason = error instanceof Error ? scrub(error.message, ctx.apiKey).slice(0, 200) : 'network error';
    throw new ProviderCallError('unreachable', `${FAILURE_TEXT.unreachable}: ${reason}`, null, error);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new ProviderCallError('invalid_response', `The provider answered with a redirect (HTTP ${response.status}); redirects are not followed`, response.status);
  }
  if (!response.ok) {
    const detail = await errorText(response, ctx.apiKey);
    const failure = failureFor(response.status, detail);
    const wait = response.status === 429 || response.status === 503 ? retryAfterSeconds(response.headers.get('retry-after')) : null;
    throw new ProviderCallError(failure, `${FAILURE_TEXT[failure]} (HTTP ${response.status})${detail ? `: ${detail}` : ''}`, response.status, undefined, wait);
  }
  return response;
}

/**
 * A provider's JSON answer, which must be an object: `null`, a list or a bare value is an
 * invalid response, not something to read fields from. The fields are untrusted (read
 * them with `untrusted.ts`).
 */
export async function readJson(response: Response, apiKey: string | null): Promise<Json> {
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw new ProviderCallError('invalid_response', FAILURE_TEXT.invalid_response, response.status, scrub(String(error), apiKey));
  }
  const json = obj(value);
  if (!json) throw new ProviderCallError('invalid_response', `${FAILURE_TEXT.invalid_response}: the answer is not a JSON object`, response.status);
  return json;
}

/** One stream event's JSON data, which must be an object. */
export function parseChunk(data: string, what = 'malformed stream chunk'): Json {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw invalidResponse(what);
  }
  const json = obj(value);
  if (!json) throw invalidResponse(what);
  return json;
}

/** Joins an endpoint base and a path without doubling or dropping slashes. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function invalidResponse(what: string): ProviderCallError {
  return new ProviderCallError('invalid_response', `${FAILURE_TEXT.invalid_response}: ${what}`);
}
