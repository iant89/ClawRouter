/**
 * Response envelope conventions for the administration API (`/api/*`).
 *
 *   success: { "data": T, "meta"?: {...} }
 *   failure: { "error": { "code", "message", "requestId", "details"? } }
 */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'AUTHENTICATION_ERROR',
  'AUTHORIZATION_ERROR',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'CONFLICT',
  'RATE_LIMITED',
  'PROVIDER_ERROR',
  'PROVIDER_TIMEOUT',
  'ROUTING_ERROR',
  'DATABASE_ERROR',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
}

export interface ApiSuccess<T> {
  data: T;
  meta?: PageMeta | Record<string, unknown>;
}

/** A single field-level validation problem. */
export interface FieldIssue {
  path: string;
  message: string;
}

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: { issues?: FieldIssue[] } & Record<string, unknown>;
  };
}

/** Header carrying the server-generated request correlation id. */
export const REQUEST_ID_HEADER = 'x-request-id';

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const error = (value as { error: unknown }).error;
  return (
    typeof error === 'object' && error !== null &&
    isErrorCode((error as { code?: unknown }).code) &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}
