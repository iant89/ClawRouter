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

// SEC-012 sessions: cookies, fixation, replay after sign-out, expiry and revocation.

import { describe, expect, test } from 'bun:test';
import type { SessionInfo } from '@clawrouter/shared';
import { ADMIN, cookieFrom } from '../../support/harness.ts';
import { createHarness, data } from '../support.ts';

const alive = async (h: ReturnType<typeof createHarness>, cookie: string) => (await h.request('/api/auth/session', { cookie })).status === 200;

describe('session cookies (SEC-012)', () => {
  test('HttpOnly, SameSite=Strict, Path=/, and __Host- Secure on HTTPS deployments', async () => {
    for (const secure of [false, true]) {
      const h = createHarness({ secureCookie: secure });
      const res = await h.request('/api/setup', { method: 'POST', json: { setupToken: 'test-setup-token-0123456789', ...ADMIN } });
      const cookie = res.headers.getSetCookie()[0]!;
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Path=/');
      expect(cookie).not.toContain('Domain=');
      if (secure) expect(cookie).toMatch(/^__Host-clawrouter_session=.*Secure/);
    }
  });

  test('the token is only in the cookie: never in a response body, and only its hash is stored', async () => {
    const h = createHarness();
    const res = await h.request('/api/setup', { method: 'POST', json: { setupToken: 'test-setup-token-0123456789', ...ADMIN } });
    const token = cookieFrom(res).split('=')[1]!;
    expect(await res.text()).not.toContain(token);
    const session = await h.request('/api/auth/session', { cookie: `clawrouter_session=${token}` });
    expect(await session.text()).not.toContain(token);
    expect(JSON.stringify(h.db.all('SELECT * FROM sessions'))).not.toContain(token);
  });
});

describe('fixation and replay (SEC-012)', () => {
  test('signing in issues a new token; a token chosen by an attacker never becomes valid', async () => {
    const h = createHarness();
    await h.completeSetup();
    const planted = 'clawrouter_session=attacker-chosen-value-0123456789';
    const res = await h.request('/api/auth/login', { method: 'POST', cookie: planted, json: { username: 'admin', password: ADMIN.password } });
    expect(res.status).toBe(200);
    expect(cookieFrom(res)).not.toBe(planted);
    expect(await alive(h, planted)).toBe(false);
    expect(await alive(h, cookieFrom(res))).toBe(true);
  });

  test('a cookie copied before sign-out is useless afterwards', async () => {
    const h = createHarness();
    const cookie = await h.completeSetup();
    expect((await h.request('/api/auth/logout', { method: 'POST', cookie })).status).toBe(204);
    expect(await alive(h, cookie)).toBe(false);
    expect((await h.request('/api/users', { cookie })).status).toBe(401);
  });
});

describe('expiry and revocation (SEC-012)', () => {
  test('idle sessions expire; active ones still end at the absolute limit', async () => {
    const h = createHarness({ idleMinutes: 60, maxHours: 12 });
    const idle = await h.completeSetup();
    const active = await h.login();
    for (let i = 0; i < 2 * 12; i++) {
      h.clock.advance(30 * 60_000);
      if (i < 23) expect([i, await alive(h, active)]).toEqual([i, true]);
    }
    expect(await alive(h, idle)).toBe(false);
    expect(await alive(h, active)).toBe(false); // 12 hours, although used every 30 minutes
  });

  test('revoking another session, changing the password and an administrator\'s reset all end sessions', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const { id } = await h.addUser('rita', ['VIEWER']);
    const phone = await h.login('rita');
    const laptop = await h.login('rita');
    const other = (await data<SessionInfo[]>(await h.request('/api/auth/sessions', { cookie: laptop }))).find((s) => !s.current)!;
    expect((await h.request(`/api/auth/sessions/${other.id}`, { method: 'DELETE', cookie: laptop })).status).toBe(204);
    expect(await alive(h, phone)).toBe(false);

    const tablet = await h.login('rita');
    expect((await h.request('/api/auth/password', { method: 'POST', cookie: laptop, json: { currentPassword: ADMIN.password, newPassword: 'a brand new passphrase 77' } })).status).toBeLessThan(300);
    expect(await alive(h, tablet)).toBe(false);

    expect((await h.request(`/api/users/${id}/password`, { method: 'POST', cookie: admin, json: { password: 'temporary passphrase 991' } })).status).toBeLessThan(300);
    expect(await alive(h, laptop)).toBe(false);
  });

  test('one user cannot revoke or list another user\'s sessions through the own-session routes', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    await h.addUser('sam', []);
    const sam = await h.login('sam');
    const adminSession = (await data<SessionInfo[]>(await h.request('/api/auth/sessions', { cookie: admin })))[0]!;
    expect((await h.request(`/api/auth/sessions/${adminSession.id}`, { method: 'DELETE', cookie: sam })).status).toBe(404);
    expect(await alive(h, admin)).toBe(true);
    expect((await data<SessionInfo[]>(await h.request('/api/auth/sessions', { cookie: sam }))).map((s) => s.id)).not.toContain(adminSession.id);
  });
});
