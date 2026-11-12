import { CSRF_HEADER, isApiErrorBody, REQUEST_ID_HEADER, type ApiSuccess, type ErrorCode, type FieldIssue, type PageMeta } from '@clawapi/shared';

/** Error raised for any failed API call, carrying the server's normalized error. */
export class ApiClientError extends Error {
  readonly code: ErrorCode | 'NETWORK_ERROR' | 'INVALID_RESPONSE';
  readonly status: number;
  readonly requestId: string | null;
  readonly issues: FieldIssue[];
  /** Seconds to wait before retrying (429 responses). */
  readonly retryAfter: number | null;

  constructor(code: ApiClientError['code'], message: string, status: number, requestId: string | null, issues: FieldIssue[] = [], retryAfter: number | null = null) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.issues = issues;
    this.retryAfter = retryAfter;
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Treat these non-2xx statuses as success (e.g. 503 from /api/health still carries a report). */
  acceptStatus?: number[];
  /** Do not report a 401 to the session handler (the auth endpoints themselves). */
  ignoreUnauthorized?: boolean;
}

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

/** The auth provider registers here so any 401 sends the user back to sign-in. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

/**
 * Thin fetch wrapper for the administration API. The session lives in an
 * HttpOnly cookie the console cannot read; no credentials are stored in the
 * browser. State-changing requests carry the CSRF header.
 */
async function request<T>(method: string, path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
  return (await requestEnvelope<T>(method, path, body, options)).data;
}

async function requestEnvelope<T>(method: string, path: string, body: unknown, options: RequestOptions = {}): Promise<ApiSuccess<T>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers[CSRF_HEADER] = '1';

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiClientError('NETWORK_ERROR', 'Cannot reach the ClawAPI server.', 0, null);
  }

  const requestId = response.headers.get(REQUEST_ID_HEADER);
  if (response.status === 401 && !options.ignoreUnauthorized) onUnauthorized?.();
  if (response.status === 204) return { data: undefined as T };

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ApiClientError('INVALID_RESPONSE', `Unexpected response (HTTP ${response.status}).`, response.status, requestId);
  }

  if (!response.ok && !options.acceptStatus?.includes(response.status)) {
    const retry = Number(response.headers.get('retry-after'));
    if (isApiErrorBody(parsed)) {
      const { code, message, requestId: rid, details } = parsed.error;
      throw new ApiClientError(code, message, response.status, rid, details?.issues ?? [], Number.isFinite(retry) && retry > 0 ? retry : null);
    }
    throw new ApiClientError('INVALID_RESPONSE', `Request failed (HTTP ${response.status}).`, response.status, requestId);
  }
  if (typeof parsed !== 'object' || parsed === null || !('data' in parsed)) {
    throw new ApiClientError('INVALID_RESPONSE', 'Response is missing data.', response.status, requestId);
  }
  return parsed as ApiSuccess<T>;
}

export interface PagedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/** GET a paginated list (server-side pagination, spec §35). */
export async function apiGetPage<T>(path: string, options?: RequestOptions): Promise<PagedResult<T>> {
  const envelope = await requestEnvelope<T[]>('GET', path, undefined, options);
  const meta = envelope.meta as Partial<PageMeta> | undefined;
  return { items: envelope.data, page: meta?.page ?? 1, pageSize: meta?.pageSize ?? envelope.data.length, total: meta?.total ?? envelope.data.length };
}

export const apiGet = <T>(path: string, options?: RequestOptions) => request<T>('GET', path, undefined, options);
export const apiPost = <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('POST', path, body ?? {}, options);
export const apiPut = <T>(path: string, body: unknown, options?: RequestOptions) => request<T>('PUT', path, body, options);
export const apiDelete = <T = void>(path: string, options?: RequestOptions) => request<T>('DELETE', path, undefined, options);
