import { normalizeError } from '@clawrouter/core';
import { REQUEST_ID_HEADER } from '@clawrouter/shared';
import type { Middleware } from './context.ts';
import { errorResponse, openAiErrorResponse } from './responses.ts';
import { API_CSP, applySecurityHeaders, type SecurityHeaderOptions } from './security-headers.ts';

/**
 * Turns any thrown error into a normalized error response. 5xx errors are
 * logged with their cause; clients only ever see the safe message.
 */
export const errorBoundary: Middleware = async (ctx, next) => {
  try {
    return await next();
  } catch (thrown) {
    const error = normalizeError(thrown);
    if (error.status >= 500) {
      ctx.log.error('request failed', { component: 'http', code: error.code, error: error.cause ?? error });
    }
    // The external gateway speaks the OpenAI error format; the admin API its own envelope.
    return ctx.url.pathname.startsWith('/v1/') ? openAiErrorResponse(error, ctx.requestId) : errorResponse(error, ctx.requestId);
  }
};

/** Adds the request id to every response so clients can quote it in bug reports. */
export const requestIdHeader: Middleware = async (ctx, next) => {
  const response = await next();
  response.headers.set(REQUEST_ID_HEADER, ctx.requestId);
  return response;
};

/** Conservative defaults for JSON API responses: nothing is cached, framed or loaded. */
export function securityHeaders(options: SecurityHeaderOptions): Middleware {
  return async (_ctx, next) => {
    const response = await next();
    applySecurityHeaders(response.headers, API_CSP, options);
    if (!response.headers.has('cache-control')) response.headers.set('cache-control', 'no-store');
    return response;
  };
}

/** One structured line per request. Never logs headers, query strings or bodies. */
export const accessLog: Middleware = async (ctx, next) => {
  const started = performance.now();
  const response = await next();
  const durationMs = Math.round((performance.now() - started) * 10) / 10;
  const level = response.status >= 500 ? 'error' : response.status >= 400 ? 'info' : 'debug';
  ctx.log[level]('http request', { component: 'http', method: ctx.method, path: ctx.url.pathname, status: response.status, durationMs });
  return response;
};
