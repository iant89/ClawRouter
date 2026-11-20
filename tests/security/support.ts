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

/** Shared setup for the security regression suite (SEC-012). */
import type { ApiSuccess, CreatedApiKey } from '@clawrouter/shared';
import { createHarness, type Harness } from '../support/harness.ts';
import type { MockProviders } from '../support/mock-providers.ts';

export const actor = { id: 'u', username: 'admin' };
export const client = { ip: null };
export const data = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;

/** An administrator, an OpenAI provider (the mock) with gpt-4o-mini, and an administrator's API key. */
export async function gatewayWorld(mock: MockProviders) {
  const h = createHarness();
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  const provider = await h.providers.create(actor, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: `${mock.url}/openai/v1`, apiKey: mock.key }, client);
  h.models.create(actor, { providerId: provider.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT'] }, client);
  const created = await data<CreatedApiKey>(await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'ci' } }));
  return { h, admin, provider, key: created.secret, keyId: created.key.id };
}

export const chat = (h: Harness, key: string | null, init: { ip?: string; headers?: Record<string, string> } = {}) =>
  h.request('/v1/chat/completions', {
    method: 'POST', ip: init.ip, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...init.headers },
    json: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }] },
  });

export { createHarness };
