import type { ApiErrorBody, ApiSuccess } from '@clawrouter/shared';
import type { AppError } from '@clawrouter/core';

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
const OPENAI_TYPE: Partial<Record<AppError['code'], string>> = {
  VALIDATION_ERROR: 'invalid_request_error',
  NOT_FOUND: 'invalid_request_error',
  METHOD_NOT_ALLOWED: 'invalid_request_error',
  CONFLICT: 'invalid_request_error',
  AUTHENTICATION_ERROR: 'authentication_error',
  AUTHORIZATION_ERROR: 'permission_error',
  RATE_LIMITED: 'rate_limit_error',
};

/**
 * Error body for the external gateway (/v1/*), in the OpenAI format so existing
 * client libraries understand it: { error: { message, type, param, code } }.
 */
export function openAiErrorResponse(error: AppError, requestId: string): Response {
  const details = (error.expose ? error.details : undefined) as { param?: string | null; code?: string } | undefined;
  const code = details?.code
    ?? (error.code === 'AUTHENTICATION_ERROR' ? 'invalid_api_key' : error.code === 'NOT_FOUND' ? 'not_found' : error.code.toLowerCase());
  return json(
    { error: { message: error.publicMessage, type: OPENAI_TYPE[error.code] ?? 'api_error', param: details?.param ?? null, code, request_id: requestId } },
    { status: error.status, headers: error.headers },
  );
}

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
