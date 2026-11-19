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

import type {
  ApiKeyInfo, ApiKeyRequestInfo, ApproveKeyRequestBody, CreateApiKeyRequest, CreateKeyRequestBody, CreatedApiKey, DenyKeyRequestBody, KeyRequestStatus,
} from '@clawrouter/shared';
import { apiDelete, apiGet, apiGetPage, apiPost } from './api-client.ts';

const enc = encodeURIComponent;

// Your own keys. The create responses are the only time a secret is available: keep it in component state only.
export const fetchMyKeys = (signal?: AbortSignal) => apiGet<ApiKeyInfo[]>('/api/me/api-keys', { signal });
export const createMyKey = (body: Omit<CreateApiKeyRequest, 'rateLimit' | 'expiresAt'>) => apiPost<CreatedApiKey>('/api/me/api-keys', body);
export const revokeMyKey = (id: string) => apiDelete<ApiKeyInfo>(`/api/me/api-keys/${enc(id)}`);

// Your key requests.
export const fetchMyRequests = (signal?: AbortSignal) => apiGet<ApiKeyRequestInfo[]>('/api/me/api-key-requests', { signal });
export const requestKey = (body: CreateKeyRequestBody) => apiPost<ApiKeyRequestInfo>('/api/me/api-key-requests', body);
export const cancelRequest = (id: string) => apiDelete<ApiKeyRequestInfo>(`/api/me/api-key-requests/${enc(id)}`);
export const createKeyFromRequest = (id: string) => apiPost<CreatedApiKey & { request: ApiKeyRequestInfo }>(`/api/me/api-key-requests/${enc(id)}/create`);

// Approvers (api_keys.write).
export const fetchKeyRequests = (query: { status?: KeyRequestStatus; page?: number; pageSize?: number }, signal?: AbortSignal) => {
  const p = new URLSearchParams();
  if (query.status) p.set('status', query.status);
  p.set('page', String(query.page ?? 1));
  p.set('pageSize', String(query.pageSize ?? 50));
  return apiGetPage<ApiKeyRequestInfo>(`/api/api-key-requests?${p}`, { signal });
};
export const approveRequest = (id: string, body: ApproveKeyRequestBody) => apiPost<ApiKeyRequestInfo>(`/api/api-key-requests/${enc(id)}/approve`, body);
export const denyRequest = (id: string, body: DenyKeyRequestBody) => apiPost<ApiKeyRequestInfo>(`/api/api-key-requests/${enc(id)}/deny`, body);
