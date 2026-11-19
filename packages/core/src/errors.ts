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

import type { ErrorCode, FieldIssue } from '@clawrouter/shared';

const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  AUTHENTICATION_ERROR: 401,
  AUTHORIZATION_ERROR: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PROVIDER_ERROR: 502,
  PROVIDER_TIMEOUT: 504,
  ROUTING_ERROR: 502,
  DATABASE_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

/** Messages used when the real message must not leave the server. */
const SAFE_MESSAGE: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'The request is invalid.',
  AUTHENTICATION_ERROR: 'Authentication is required.',
  AUTHORIZATION_ERROR: 'You do not have permission to perform this action.',
  NOT_FOUND: 'The requested resource was not found.',
  METHOD_NOT_ALLOWED: 'The method is not allowed for this resource.',
  CONFLICT: 'The request conflicts with the current state of the resource.',
  RATE_LIMITED: 'Too many requests.',
  PROVIDER_ERROR: 'The upstream provider returned an error.',
  PROVIDER_TIMEOUT: 'The upstream provider did not respond in time.',
  ROUTING_ERROR: 'No eligible provider could handle the request.',
  DATABASE_ERROR: 'A database error occurred.',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable.',
  INTERNAL_ERROR: 'An internal error occurred.',
};

export interface AppErrorOptions {
  /** Whether `message` is safe to show to clients. Defaults to true for 4xx codes, false otherwise. */
  expose?: boolean;
  /** Client-safe structured details (never secrets). */
  details?: { issues?: FieldIssue[] } & Record<string, unknown>;
  /** Extra headers for the HTTP response (e.g. `Allow`, `Retry-After`). */
  headers?: Record<string, string>;
  cause?: unknown;
}

/** The single error type thrown by ClawRouter domain and application code. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly expose: boolean;
  readonly details: AppErrorOptions['details'];
  readonly headers: Record<string, string>;

  constructor(code: ErrorCode, message?: string, options: AppErrorOptions = {}) {
    super(message ?? SAFE_MESSAGE[code], options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = HTTP_STATUS[code];
    this.expose = options.expose ?? this.status < 500;
    this.details = options.details;
    this.headers = options.headers ?? {};
  }

  /** The message a client may see. */
  get publicMessage(): string {
    return this.expose ? this.message : SAFE_MESSAGE[this.code];
  }
}

export const errors = {
  validation: (issues: FieldIssue[], message = 'The request is invalid.') =>
    new AppError('VALIDATION_ERROR', message, { details: { issues } }),
  notFound: (message?: string) => new AppError('NOT_FOUND', message),
  methodNotAllowed: (allowed: string[]) =>
    new AppError('METHOD_NOT_ALLOWED', undefined, { headers: { Allow: allowed.join(', ') } }),
  conflict: (message?: string) => new AppError('CONFLICT', message),
  internal: (cause?: unknown) => new AppError('INTERNAL_ERROR', undefined, { cause }),
  database: (cause?: unknown) => new AppError('DATABASE_ERROR', undefined, { cause }),
};

/** Converts anything thrown into an AppError. Unknown errors become INTERNAL_ERROR (message hidden). */
export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return errors.internal(error);
}

export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS[code];
}
