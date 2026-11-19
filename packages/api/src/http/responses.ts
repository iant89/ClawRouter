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
    ?? (error.code === 'AUTHENTICATION_ERROR' ? 'invalid_api_key' : error.code === 'NOT_FOUND' ? 'not_found' : error.code === 'RATE_LIMITED' ? 'rate_limit_exceeded' : error.code.toLowerCase());
  return json(
    { error: { message: error.publicMessage, type: OPENAI_TYPE[error.code] ?? 'api_error', param: details?.param ?? null, code, request_id: requestId } },
    { status: error.status, headers: error.headers },
  );
}

/** Anthropic's error types by HTTP status. */
const ANTHROPIC_TYPE: Record<number, string> = {
  400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error',
  405: 'invalid_request_error', 409: 'invalid_request_error', 413: 'request_too_large', 429: 'rate_limit_error',
  503: 'overloaded_error', 504: 'timeout_error',
};

/**
 * Error body for /v1/messages, in Anthropic's format so the Anthropic SDKs and
 * Claude Code understand it: { type: "error", error: { type, message }, request_id }.
 */
export function anthropicErrorResponse(error: AppError, requestId: string): Response {
  const headers = new Headers(error.headers);
  headers.set('request-id', requestId);
  return json(
    { type: 'error', error: { type: ANTHROPIC_TYPE[error.status] ?? 'api_error', message: error.publicMessage }, request_id: requestId },
    { status: error.status, headers },
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
