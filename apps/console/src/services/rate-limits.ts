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

import type { ApiKeyInfo, PutRateLimitsRequest, RateLimitConfigView, RateLimitUsage, UpdateApiKeyRequest } from '@clawrouter/shared';
import { apiGet, apiPut, request } from './api-client.ts';

export const fetchRateLimits = (signal?: AbortSignal) => apiGet<RateLimitConfigView>('/api/rate-limits', { signal });
export const saveRateLimits = (body: PutRateLimitsRequest) => apiPut<RateLimitConfigView>('/api/rate-limits', body);
export const fetchRateLimitUsage = (signal?: AbortSignal) => apiGet<RateLimitUsage>('/api/rate-limits/usage', { signal });
export const updateApiKey = (id: string, body: UpdateApiKeyRequest) => request<ApiKeyInfo>('PATCH', `/api/api-keys/${encodeURIComponent(id)}`, body);
