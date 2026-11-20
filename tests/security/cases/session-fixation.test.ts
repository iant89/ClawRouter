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

// SEC-027 corpus: session fixation and replay.

import { describe, expect, test } from 'bun:test';
import { ADMIN, cookieFrom } from '../../support/harness.ts';
import { createHarness } from '../support.ts';

const alive = async (h: ReturnType<typeof createHarness>, cookie: string) => (await h.request('/api/auth/session', { cookie })).status === 200;

describe('session fixation', () => {
  test('CASE-013: a token planted by an attacker never becomes a session; signing in issues a new one, also over a live one', async () => {
    const h = createHarness();
    const first = await h.completeSetup();
    const planted = 'clawrouter_session=attacker-chosen-value-0123456789';
    const res = await h.request('/api/auth/login', { method: 'POST', cookie: planted, json: { username: 'admin', password: ADMIN.password } });
    expect(res.status).toBe(200);
    expect(cookieFrom(res)).not.toBe(planted);
    expect(await alive(h, planted)).toBe(false);
    // Signing in while a session cookie is already set gives a different token too.
    const again = await h.request('/api/auth/login', { method: 'POST', cookie: first, json: { username: 'admin', password: ADMIN.password } });
    expect(cookieFrom(again)).not.toBe(first);
    expect(await alive(h, cookieFrom(again))).toBe(true);
  });

  test('CASE-014: a token copied before sign-out is refused afterwards, also by the live channel', async () => {
    const h = createHarness();
    const cookie = await h.completeSetup();
    expect((await h.request('/api/auth/logout', { method: 'POST', cookie })).status).toBe(204);
    expect(await alive(h, cookie)).toBe(false);
    expect(h.auth.resolve(cookie.split('=')[1]!)).toBeNull();
  });
});
