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

import { describe, expect, test } from 'bun:test';
import type { ApiSuccess, AuthSession } from '@clawrouter/shared';
import { createHarness } from '../../../tests/support/harness.ts';

const data = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;

describe('console theme (owner request: light, dark, system, on the account)', () => {
  test('dark by default; each user picks their own, and it comes back in every session', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    await h.addUser('vera', ['VIEWER'], 'quiet meadow lantern 42');
    const viewer = await h.login('vera', 'quiet meadow lantern 42');
    const session = async (cookie: string) => data<AuthSession>(await h.request('/api/auth/session', { cookie }));
    expect((await session(admin)).theme).toBe('dark');

    expect(await data<{ theme: string }>(await h.request('/api/auth/theme', { method: 'PUT', cookie: admin, json: { theme: 'light' } }))).toEqual({ theme: 'light' });
    expect((await session(admin)).theme).toBe('light');
    expect((await session(viewer)).theme).toBe('dark');

    // Another sign-in (another device) gets the same choice.
    const again = await h.login();
    expect((await session(again)).theme).toBe('light');

    await h.request('/api/auth/theme', { method: 'PUT', cookie: viewer, json: { theme: 'system' } });
    expect((await session(viewer)).theme).toBe('system');
  });

  test('anything else is refused, and it needs a signed-in user', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    for (const json of [{ theme: 'high-contrast' }, { theme: 'blue' }, {}]) {
      expect((await h.request('/api/auth/theme', { method: 'PUT', cookie: admin, json })).status).toBe(400);
    }
    expect((await h.request('/api/auth/theme', { method: 'PUT', json: { theme: 'light' } })).status).toBe(401);
  });

  test('a user with a temporary password cannot change it yet (only the password change is allowed)', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    await h.request('/api/users', { method: 'POST', cookie: admin, json: { username: 'tim', displayName: 'Tim', password: 'temporary harbor sixty 77', roles: ['VIEWER'] } });
    const tim = await h.login('tim', 'temporary harbor sixty 77');
    expect((await h.request('/api/auth/theme', { method: 'PUT', cookie: tim, json: { theme: 'light' } })).status).toBe(403);
  });
});
