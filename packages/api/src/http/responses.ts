import type { ApiErrorBody, ApiSuccess } from '@clawapi/shared';
import type { AppError } from '@clawapi/core';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(JSON_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  return new Response(JSON.stringify(body), { ...init, headers });
}

/** Success envelope: `{ data, meta? }`. */
export function ok<T>(data: T, init: ResponseInit & { meta?: ApiSuccess<T>['meta'] } = {}): Response {
  const { meta, ...rest } = init;
  const body: ApiSuccess<T> = meta ? { data, meta } : { data };
  return json(body, { status: 200, ...rest });
}

export function created<T>(data: T, location?: string): Response {
  return ok(data, { status: 201, headers: location ? { location } : undefined });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/** Error envelope. Only client-safe information leaves the server. */
export function errorResponse(error: AppError, requestId: string): Response {
  const body: ApiErrorBody = {
    error: {
      code: error.code,
      message: error.publicMessage,
      requestId,
      ...(error.expose && error.details ? { details: error.details } : {}),
    },
  };
  return json(body, { status: error.status, headers: error.headers });
}
