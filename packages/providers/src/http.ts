import { AppError } from '@clawapi/core';
import type { ProviderCallContext } from './types.ts';

/** Why a provider call failed, in provider-independent terms. */
export type ProviderFailure = 'auth' | 'rate_limited' | 'timeout' | 'unreachable' | 'bad_request' | 'not_found' | 'server_error' | 'invalid_response' | 'cancelled';

/**
 * A failed provider call. `message` is safe to show administrators: it never
 * contains the API key (scrubbed) and provider error text is truncated.
 */
export class ProviderCallError extends AppError {
  readonly failure: ProviderFailure;
  readonly httpStatus: number | null;

  constructor(failure: ProviderFailure, message: string, httpStatus: number | null = null, cause?: unknown) {
    super(failure === 'timeout' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR', message, { expose: true, cause });
    this.failure = failure;
    this.httpStatus = httpStatus;
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
      const body = JSON.parse(raw) as { error?: { message?: unknown } | string; message?: unknown };
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

function failureFor(status: number): ProviderFailure {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server_error';
  return 'bad_request';
}

const FAILURE_TEXT: Record<ProviderFailure, string> = {
  auth: 'The provider rejected the credentials',
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
    const reason = error instanceof Error ? scrub(error.message, ctx.apiKey).slice(0, 200) : 'network error';
    throw new ProviderCallError('unreachable', `${FAILURE_TEXT.unreachable}: ${reason}`, null, error);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new ProviderCallError('invalid_response', `The provider answered with a redirect (HTTP ${response.status}); redirects are not followed`, response.status);
  }
  if (!response.ok) {
    const failure = failureFor(response.status);
    const detail = await errorText(response, ctx.apiKey);
    throw new ProviderCallError(failure, `${FAILURE_TEXT[failure]} (HTTP ${response.status})${detail ? `: ${detail}` : ''}`, response.status);
  }
  return response;
}

export async function readJson<T>(response: Response, apiKey: string | null): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new ProviderCallError('invalid_response', FAILURE_TEXT.invalid_response, response.status, scrub(String(error), apiKey));
  }
}

/** Joins an endpoint base and a path without doubling or dropping slashes. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function invalidResponse(what: string): ProviderCallError {
  return new ProviderCallError('invalid_response', `${FAILURE_TEXT.invalid_response}: ${what}`);
}
