import { normalizeError } from '@clawapi/core';
import { REQUEST_ID_HEADER } from '@clawapi/shared';
import type { Middleware } from './context.ts';
import { errorResponse } from './responses.ts';

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
    return errorResponse(error, ctx.requestId);
  }
};

/** Adds the request id to every response so clients can quote it in bug reports. */
export const requestIdHeader: Middleware = async (ctx, next) => {
  const response = await next();
  response.headers.set(REQUEST_ID_HEADER, ctx.requestId);
  return response;
};

/** Conservative defaults for JSON API responses. */
export const securityHeaders: Middleware = async (_ctx, next) => {
  const response = await next();
  const h = response.headers;
  h.set('x-content-type-options', 'nosniff');
  h.set('x-frame-options', 'DENY');
  h.set('referrer-policy', 'no-referrer');
  h.set('cross-origin-resource-policy', 'same-origin');
  if (!h.has('cache-control')) h.set('cache-control', 'no-store');
  return response;
};

/** One structured line per request. Never logs headers, query strings or bodies. */
export const accessLog: Middleware = async (ctx, next) => {
  const started = performance.now();
  const response = await next();
  const durationMs = Math.round((performance.now() - started) * 10) / 10;
  const level = response.status >= 500 ? 'error' : response.status >= 400 ? 'info' : 'debug';
  ctx.log[level]('http request', { component: 'http', method: ctx.method, path: ctx.url.pathname, status: response.status, durationMs });
  return response;
};
