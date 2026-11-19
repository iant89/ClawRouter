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

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, silentLogger } from '@clawrouter/core';
import { CSRF_HEADER, type RealtimeServerMessage } from '@clawrouter/shared';
import { startClawRouter, type ClawRouter } from '../src/server.ts';
import { ADMIN, fastHasher } from '../../../tests/support/harness.ts';

/** A WebSocket client that records messages and how it closed. */
function connect(url: URL, headers: Record<string, string>) {
  const messages: RealtimeServerMessage[] = [];
  const ws = new WebSocket(url.href.replace(/^http/, 'ws'), { headers } as unknown as string[]);
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })));
  ws.addEventListener('message', (e) => messages.push(JSON.parse(String(e.data)) as RealtimeServerMessage));
  const next = async (predicate: (m: RealtimeServerMessage) => boolean, timeoutMs = 2000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = messages.find(predicate);
      if (found) return found;
      await Bun.sleep(10);
    }
    throw new Error('message not received');
  };
  return { ws, messages, closed, next };
}

/** The live channel end to end: real Bun server, real WebSocket, real session cookie. */
describe('/api/ws', () => {
  let app: ClawRouter;
  let dir: string;
  let cookie: string;
  let wsUrl: URL;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'clawrouter-ws-'));
    const config = loadConfig({ CLAWROUTER_ENV: 'test', CLAWROUTER_PORT: '0', CLAWROUTER_DATABASE_PATH: join(dir, 'clawrouter.db') });
    app = await startClawRouter({ config, log: silentLogger, version: 'test', hasher: fastHasher });
    const token = readFileSync(join(dir, 'setup-token'), 'utf8').trim();
    const setup = await fetch(new URL('/api/setup', app.url), {
      method: 'POST', headers: { 'content-type': 'application/json', origin: app.url.origin }, body: JSON.stringify({ setupToken: token, ...ADMIN }),
    });
    cookie = setup.headers.getSetCookie()[0]!.split(';')[0]!;
    wsUrl = new URL('/api/ws', app.url);
  });
  afterAll(async () => {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a signed-in console connects, gets hello, and answers pings', async () => {
    const c = connect(wsUrl, { cookie, origin: app.url.origin });
    expect(await c.next((m) => m.type === 'hello')).toMatchObject({ user: { username: ADMIN.username } });
    c.ws.send(JSON.stringify({ type: 'ping' }));
    await c.next((m) => m.type === 'pong');
    c.ws.close();
    await c.closed;
  });

  test('no session or another origin: the upgrade is refused', async () => {
    const anonymous = connect(wsUrl, { origin: app.url.origin });
    expect((await anonymous.closed).code).not.toBe(1000);
    expect(anonymous.messages).toEqual([]);
    const crossSite = connect(wsUrl, { cookie, origin: 'https://evil.example' });
    await crossSite.closed;
    expect(crossSite.messages).toEqual([]);
    const plain = await fetch(wsUrl, { headers: { cookie, origin: app.url.origin } });
    expect(plain.status).toBe(400);
  });

  test('changes made through the API arrive as events; signing out closes the connection with 4401', async () => {
    const c = connect(wsUrl, { cookie, origin: app.url.origin });
    await c.next((m) => m.type === 'hello');
    const headers = { cookie, origin: app.url.origin, 'content-type': 'application/json', [CSRF_HEADER]: '1' };
    const routing = await fetch(new URL('/api/routing', app.url), { headers: { cookie } });
    const { data } = (await routing.json()) as { data: { version: number; defaultPolicy: unknown } };
    const put = await fetch(new URL('/api/routing', app.url), { method: 'PUT', headers, body: JSON.stringify({ version: data.version, defaultPolicy: data.defaultPolicy, aliases: [] }) });
    expect(put.status).toBe(200);
    expect(await c.next((m) => m.type === 'event' && m.name === 'routing.changed')).toMatchObject({ data: { version: data.version + 1 } });

    const logout = await fetch(new URL('/api/auth/logout', app.url), { method: 'POST', headers });
    expect(logout.status).toBe(204);
    expect((await c.closed).code).toBe(4401);
    expect(app.realtime.size).toBe(0);
  });
});
