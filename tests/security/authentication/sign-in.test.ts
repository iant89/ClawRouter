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

// SEC-012 authentication: what an attacker at the sign-in form can learn or do.

import { describe, expect, test } from 'bun:test';
import type { ApiErrorBody } from '@clawrouter/shared';
import { ADMIN, createHarness, SETUP_TOKEN } from '../../support/harness.ts';

const login = (h: ReturnType<typeof createHarness>, username: string, password: string, ip?: string) =>
  h.request('/api/auth/login', { method: 'POST', json: { username, password }, ip });
const body = async (res: Response) => ((await res.json()) as ApiErrorBody).error;

describe('sign-in (SEC-012)', () => {
  test('an unknown username and a wrong password look the same (no username enumeration)', async () => {
    const h = createHarness();
    await h.completeSetup();
    const unknown = await login(h, 'nobody-here', 'wrong password');
    const wrong = await login(h, 'admin', 'wrong password');
    expect([unknown.status, wrong.status]).toEqual([401, 401]);
    const strip = ({ requestId: _, ...rest }: Record<string, unknown>) => rest;
    expect(strip(await body(unknown) as unknown as Record<string, unknown>)).toEqual(strip(await body(wrong) as unknown as Record<string, unknown>));
  });

  test('the typed username of a failed sign-in is stored only when the account exists', async () => {
    const h = createHarness();
    await h.completeSetup();
    await login(h, 'adnim-typo-x7', 'correct horse battery staple'); // a password typed into the username box
    const rows = h.db.all<{ metadata: string | null }>('SELECT metadata FROM audit_log');
    expect(JSON.stringify(rows)).not.toContain('adnim-typo-x7');
  });

  test('repeated failures lock the account, even for the right password, until the window passes', async () => {
    const h = createHarness();
    await h.completeSetup();
    for (let i = 0; i < 10; i++) await login(h, 'admin', `guess ${i}`, `198.51.100.${i}`); // from many addresses
    expect((await login(h, 'admin', ADMIN.password, '198.51.100.200')).status).toBe(429);
    h.clock.advance(16 * 60_000);
    expect((await login(h, 'admin', ADMIN.password, '198.51.100.200')).status).toBe(200);
  });

  test('a disabled account cannot sign in', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const { id } = await h.addUser('dora', ['VIEWER']);
    expect((await h.request(`/api/users/${id}`, { method: 'PATCH', cookie: admin, json: { status: 'DISABLED' } })).status).toBe(200);
    expect((await login(h, 'dora', ADMIN.password)).status).toBe(401);
  });

  test('passwords never appear in responses, audit records or logs', async () => {
    const h = createHarness();
    await h.completeSetup();
    const ok = await login(h, 'admin', ADMIN.password);
    expect(await ok.text()).not.toContain(ADMIN.password);
    await login(h, 'admin', 'a-wrong-but-memorable-password');
    const stored = JSON.stringify(h.db.all('SELECT * FROM audit_log')) + JSON.stringify(h.logs);
    expect(stored).not.toContain(ADMIN.password);
    expect(stored).not.toContain('a-wrong-but-memorable-password');
    expect(JSON.stringify(h.db.all('SELECT password_hash FROM users'))).not.toContain(ADMIN.password);
  });
});

describe('first setup (SEC-012)', () => {
  test('needs the setup token, and cannot be replayed once an administrator exists', async () => {
    const h = createHarness();
    const setup = (token: string, username: string) => h.request('/api/setup', { method: 'POST', json: { setupToken: token, username, displayName: 'X', password: 'another long passphrase 42' } });
    expect((await setup('wrong-token-0123456789', 'eve')).status).toBe(401);
    expect((await setup(SETUP_TOKEN, 'admin')).status).toBe(201);
    const replay = await setup(SETUP_TOKEN, 'mallory');
    expect([401, 403, 409]).toContain(replay.status);
    expect(h.db.all<{ username: string }>('SELECT username FROM users').map((u) => u.username)).toEqual(['admin']);
  });
});
