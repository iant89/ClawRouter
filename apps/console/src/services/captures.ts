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

import {
  CSRF_HEADER, isApiErrorBody,
  type CaptureDetail, type CaptureState, type CaptureSummary, type CaptureTrigger, type ManualCaptureInfo, type StartManualCaptureRequest,
} from '@clawrouter/shared';
import { apiDelete, apiGet, apiGetPage, apiPost, ApiClientError } from './api-client.ts';

/** Provider captures (System → Captures). */
export const fetchCaptureState = (signal?: AbortSignal) => apiGet<CaptureState>('/api/captures/state', { signal });

export function fetchCaptures(q: { page: number; pageSize: number; trigger?: CaptureTrigger; providerId?: string; requestId?: string }, signal?: AbortSignal) {
  const p = new URLSearchParams({ page: String(q.page), pageSize: String(q.pageSize) });
  if (q.trigger) p.set('trigger', q.trigger);
  if (q.providerId) p.set('providerId', q.providerId);
  if (q.requestId) p.set('requestId', q.requestId);
  return apiGetPage<CaptureSummary>(`/api/captures?${p}`, { signal });
}

export const fetchCapture = (id: string, signal?: AbortSignal) => apiGet<CaptureDetail>(`/api/captures/${encodeURIComponent(id)}`, { signal });
export const startManualCapture = (body: StartManualCaptureRequest) => apiPost<ManualCaptureInfo>('/api/captures/manual', body);
export const stopManualCapture = () => apiDelete<CaptureState>('/api/captures/manual');
export const deleteCaptures = (body: { ids: string[] } | { all: true }) => apiPost<{ deleted: number }>('/api/captures/delete', body);

/**
 * Downloads the export file. The server answers with the file itself (not the
 * usual JSON envelope), named by its Content-Disposition.
 */
export async function downloadCaptures(ids: string[], maskText: boolean): Promise<string> {
  let response: Response;
  try {
    response = await fetch('/api/captures/export', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json', [CSRF_HEADER]: '1' },
      body: JSON.stringify({ ids, maskText }),
    });
  } catch {
    throw new ApiClientError('NETWORK_ERROR', 'Cannot reach the ClawRouter server.', 0, null);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    if (isApiErrorBody(body)) throw new ApiClientError(body.error.code, body.error.message, response.status, body.error.requestId);
    throw new ApiClientError('INVALID_RESPONSE', `Export failed (HTTP ${response.status}).`, response.status, null);
  }
  const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'clawrouter-capture.json';
  const url = URL.createObjectURL(await response.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}
