import { isApiErrorBody, REQUEST_ID_HEADER, type ApiSuccess, type ErrorCode } from '@clawapi/shared';

/** Error raised for any failed API call, carrying the server's normalized error. */
export class ApiClientError extends Error {
  readonly code: ErrorCode | 'NETWORK_ERROR' | 'INVALID_RESPONSE';
  readonly status: number;
  readonly requestId: string | null;

  constructor(code: ApiClientError['code'], message: string, status: number, requestId: string | null) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Treat these non-2xx statuses as success (e.g. 503 from /api/health still carries a report). */
  acceptStatus?: number[];
}

/**
 * Thin fetch wrapper for the administration API. Cookies are same-origin
 * (server-side sessions from Phase 2); no credentials are ever stored in the browser.
 */
export async function apiGet<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiClientError('NETWORK_ERROR', 'Cannot reach the ClawAPI server.', 0, null);
  }

  const requestId = response.headers.get(REQUEST_ID_HEADER);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiClientError('INVALID_RESPONSE', `Unexpected response (HTTP ${response.status}).`, response.status, requestId);
  }

  if (!response.ok && !options.acceptStatus?.includes(response.status)) {
    if (isApiErrorBody(body)) throw new ApiClientError(body.error.code, body.error.message, response.status, body.error.requestId);
    throw new ApiClientError('INVALID_RESPONSE', `Request failed (HTTP ${response.status}).`, response.status, requestId);
  }
  if (typeof body !== 'object' || body === null || !('data' in body)) {
    throw new ApiClientError('INVALID_RESPONSE', 'Response is missing data.', response.status, requestId);
  }
  return (body as ApiSuccess<T>).data;
}
