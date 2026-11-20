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

// SEC-027 corpus: who may open the console's live channel.

import { describe, expect, test } from 'bun:test';
import { createRealtimeHub } from '@clawrouter/api';
import { REALTIME_PATH } from '@clawrouter/shared';
import { createHarness } from '../support.ts';

async function world() {
  const h = createHarness();
  const cookie = await h.completeSetup();
  const hub = createRealtimeHub({ events: h.events, auth: h.auth, authz: h.authz, cookie: { secure: false }, now: h.clock.now });
  const upgrade = (headers: Record<string, string>) => {
    const r = hub.authorize(new Request(`http://clawrouter.test${REALTIME_PATH}`, { headers: { host: 'clawrouter.test', upgrade: 'websocket', connection: 'Upgrade', ...headers } }));
    return r.ok ? 101 : r.response.status;
  };
  return { h, hub, cookie, upgrade };
}

describe('websocket authorization', () => {
  test('CASE-032: only a console session from the same origin opens the channel', async () => {
    const { h, hub, cookie, upgrade } = await world();
    const own = { origin: 'http://clawrouter.test' };
    expect(upgrade({ ...own, cookie })).toBe(101);
    expect(upgrade(own)).toBe(401);
    expect(upgrade({ ...own, cookie: 'clawrouter_session=forged-value-0123456789' })).toBe(401);
    // Cross-site WebSocket hijacking: the browser sends the cookie, the Origin gives the page away.
    for (const origin of ['https://evil.example', 'null', 'http://clawrouter.test.evil.example', 'http://clawrouter.test:9999']) expect([origin, upgrade({ origin, cookie })]).toEqual([origin, 403]);
    expect(upgrade({ cookie })).toBe(403);
    // An API key is not a console session.
    const userId = h.auth.resolve(cookie.split('=')[1]!)!.user.id;
    const key = h.apiKeys.create({ id: userId, username: 'admin' }, { name: 'k', expiry: { type: 'after', hours: 1 } }, { ip: null }).secret;
    expect(upgrade({ ...own, authorization: `Bearer ${key}` })).toBe(401);
    hub.stop();
  });

  test('CASE-033: an account that must change its password cannot open the channel', async () => {
    const { h, hub, upgrade } = await world();
    const user = await h.addUser('tess', ['VIEWER']);
    const cookie = await h.login('tess');
    h.db.run('UPDATE users SET must_change_password = 1 WHERE id = ?', [user.id]);
    expect(upgrade({ origin: 'http://clawrouter.test', cookie })).toBe(403);
    hub.stop();
  });
});
