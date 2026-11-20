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

// SEC-015: the console's live channel over a real socket. Each case in the roadmap's test list:
// valid, expired, revoked and invalid sessions, cross-origin, oversized and malformed frames,
// rapid reconnects. The hub's own unit tests are in packages/api/test/realtime.test.ts.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { createRealtimeHub, REALTIME_SOCKET_OPTIONS, type SocketData } from '@clawrouter/api';
import { REALTIME_PATH, type RealtimeServerMessage } from '@clawrouter/shared';
import { createHarness, type Harness } from '../../support/harness.ts';

const running: { stop(): void }[] = [];
afterEach(() => { for (const r of running.splice(0)) r.stop(); });

/** The harness behind a real Bun server with the live channel wired as in apps/server/src/server.ts. */
function serve(h: Harness, options: Partial<Parameters<typeof createRealtimeHub>[0]> = {}) {
  const hub = createRealtimeHub({ events: h.events, auth: h.auth, authz: h.authz, cookie: { secure: false }, now: h.clock.now, ...options });
  const server: Server<SocketData> = Bun.serve<SocketData>({
    hostname: '127.0.0.1', port: 0,
    fetch(request, srv) {
      if (new URL(request.url).pathname === REALTIME_PATH) {
        const check = hub.authorize(request);
        if (!check.ok) return check.response;
        if (srv.upgrade(request, { data: check.data })) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      return h.api.handle(request, '127.0.0.1');
    },
    websocket: { open: (ws) => hub.open(ws), message: (ws, m) => hub.message(ws, m), close: (ws) => hub.close(ws), ...REALTIME_SOCKET_OPTIONS },
  });
  running.push({ stop: () => { hub.stop(); server.stop(true); } });
  const origin = `http://127.0.0.1:${server.port}`;
  return { hub, server, origin, url: `ws://127.0.0.1:${server.port}${REALTIME_PATH}` };
}

interface Opened { ws: WebSocket; messages: RealtimeServerMessage[]; closed: Promise<{ code: number; reason: string }>; next(): Promise<RealtimeServerMessage> }

/** Opens a socket and waits for `hello`; rejects if the upgrade is refused. */
function open(url: string, headers: Record<string, string>): Promise<Opened> {
  return new Promise((resolve, reject) => {
    // Bun's client accepts headers, which is how a non-browser attacker would connect too.
    const ws = new WebSocket(url, { headers } as unknown as string[]);
    const messages: RealtimeServerMessage[] = [];
    const waiting: ((m: RealtimeServerMessage) => void)[] = [];
    let closedResolve!: (v: { code: number; reason: string }) => void;
    const closed = new Promise<{ code: number; reason: string }>((r) => { closedResolve = r; });
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as RealtimeServerMessage;
      messages.push(m);
      waiting.shift()?.(m);
      if (m.type === 'hello' && messages.length === 1) resolve(opened);
    };
    ws.onclose = (ev) => { closedResolve({ code: ev.code, reason: ev.reason }); reject(new Error(`closed ${ev.code}`)); };
    ws.onerror = () => reject(new Error('refused'));
    const opened: Opened = { ws, messages, closed, next: () => new Promise((r) => waiting.push(r)) };
  });
}

/** The HTTP status an upgrade attempt gets. */
async function upgradeStatus(origin: string, headers: Record<string, string>) {
  const res = await fetch(`${origin}${REALTIME_PATH}`, {
    headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': btoa('0123456789abcdef'), ...headers },
  });
  return res.status;
}

async function world(options: Partial<Parameters<typeof createRealtimeHub>[0]> = {}) {
  const h = createHarness();
  const cookie = await h.completeSetup();
  const s = serve(h, options);
  return { h, cookie, ...s, headers: { cookie, origin: s.origin } };
}

describe('sessions (SEC-015)', () => {
  test('a valid session connects, gets hello without its token, and ping gets pong', async () => {
    const { url, headers, cookie } = await world();
    const c = await open(url, headers);
    expect(c.messages[0]).toMatchObject({ type: 'hello', user: { username: 'admin' } });
    expect(JSON.stringify(c.messages)).not.toContain(cookie.split('=')[1]!);
    const pong = c.next();
    c.ws.send('{"type":"ping"}');
    expect(await pong).toEqual({ type: 'pong' });
    c.ws.close();
  });

  test('invalid, missing and API-key credentials are refused with 401', async () => {
    const { h, origin, cookie } = await world();
    const key = h.apiKeys.create({ id: (h.auth.resolve(cookie.split('=')[1]!)!).user.id, username: 'admin' }, { name: 'k', expiry: { type: 'after', hours: 1 } }, { ip: null });
    expect(await upgradeStatus(origin, { origin })).toBe(401);
    expect(await upgradeStatus(origin, { origin, cookie: 'clawrouter_session=forged-session-value' })).toBe(401);
    expect(await upgradeStatus(origin, { origin, authorization: `Bearer ${key}` })).toBe(401);
    expect(await upgradeStatus(origin, { origin, cookie: `clawrouter_session=${key}` })).toBe(401);
  });

  test('an expired session cannot connect, and an open connection is closed at the next ping', async () => {
    const { h, url, origin, headers } = await world();
    const c = await open(url, headers);
    h.clock.advance(61 * 60_000); // past the 60-minute idle limit
    c.ws.send('{"type":"ping"}');
    expect((await c.closed).code).toBe(4401);
    expect(await upgradeStatus(origin, headers)).toBe(401);
  });

  test('a revoked session is closed at once (sign-out), and cannot reconnect', async () => {
    const { h, url, origin, headers, cookie } = await world();
    const c = await open(url, headers);
    expect((await h.request('/api/auth/logout', { method: 'POST', cookie })).status).toBe(204);
    expect((await c.closed).code).toBe(4401);
    expect(await upgradeStatus(origin, headers)).toBe(401);
  });

  test('a disabled user is disconnected', async () => {
    const { h, url, origin, cookie } = await world();
    const vera = await h.addUser('vera', ['VIEWER']);
    const veraCookie = await h.login('vera');
    const c = await open(url, { cookie: veraCookie, origin });
    expect((await h.request(`/api/users/${vera.id}`, { method: 'PATCH', cookie, json: { status: 'DISABLED' } })).status).toBe(200);
    expect((await c.closed).code).toBe(4401);
  });
});

describe('origin (SEC-015)', () => {
  test('another site, a missing origin, "null" and a look-alike host are refused with 403', async () => {
    const { origin, cookie } = await world();
    const port = new URL(origin).port;
    for (const o of ['https://evil.example', 'null', `http://127.0.0.1.evil.example:${port}`, `http://localhost:${port}`, 'not a url']) {
      expect([o, await upgradeStatus(origin, { cookie, origin: o })]).toEqual([o, 403]);
    }
    expect(await upgradeStatus(origin, { cookie })).toBe(403);
    expect(await upgradeStatus(origin, { cookie, origin })).toBe(101);
  });
});

describe('messages and frames (SEC-015)', () => {
  test('a frame over 4 KB is refused by the server before the hub sees it (1009)', async () => {
    const { url, headers } = await world();
    const c = await open(url, headers);
    c.ws.send(`{"type":"ping","x":"${'a'.repeat(5000)}"}`);
    expect((await c.closed).code).toBe(1009);
  });

  test('a message between 1 and 4 KB, a binary frame and an unknown message each close the connection', async () => {
    const { url, headers } = await world();
    const cases: [string | Uint8Array<ArrayBuffer>, number][] = [
      ['x'.repeat(2000), 1009],
      [new TextEncoder().encode('{"type":"ping"}'), 1003],
      ['{"type":"subscribe","events":["*"]}', 1008],
      ['{not json', 1008],
    ];
    for (const [message, code] of cases) {
      const c = await open(url, headers);
      c.ws.send(message);
      expect((await c.closed).code).toBe(code);
    }
  });

  test('a malformed frame (unmasked client frame, reserved bits) ends the connection', async () => {
    const { origin, cookie, hub } = await world();
    const port = Number(new URL(origin).port);
    for (const frame of [
      new Uint8Array([0x81, 0x04, 0x70, 0x69, 0x6e, 0x67]), // text frame without the mask clients must use
      new Uint8Array([0xf1, 0x80, 0, 0, 0, 0]), // reserved bits set
      new Uint8Array([0x8b, 0x80, 0, 0, 0, 0]), // unknown opcode 0xB
    ]) {
      const ended = new Promise<string>((resolve) => {
        let received = '';
        let upgraded = false;
        void Bun.connect({
          hostname: '127.0.0.1', port,
          socket: {
            open(s) {
              s.write(`GET ${REALTIME_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${btoa('0123456789abcdef')}\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\n\r\n`);
            },
            data(s, d) {
              received += new TextDecoder().decode(d);
              if (!upgraded && received.includes('\r\n\r\n')) {
                upgraded = true;
                expect(received.startsWith('HTTP/1.1 101')).toBe(true);
                s.write(frame);
              }
            },
            close() { resolve(received); },
            error() { resolve(received); },
          },
        });
      });
      const text = await ended;
      expect(text.startsWith('HTTP/1.1 101')).toBe(true);
      expect(text).not.toContain('"type":"pong"');
    }
    await Bun.sleep(20);
    expect(hub.size).toBe(0);
  });

  test('a flood of pings closes the connection (1008)', async () => {
    const { url, headers } = await world();
    const c = await open(url, headers);
    for (let i = 0; i < 50; i++) c.ws.send('{"type":"ping"}');
    expect((await c.closed).code).toBe(1008);
    expect(c.messages.filter((m) => m.type === 'pong').length).toBeLessThanOrEqual(20);
  });
});

describe('connection limits and reconnects (SEC-015)', () => {
  test('rapid reconnects are refused with 429 and Retry-After; other users still connect', async () => {
    const { h, url, origin, headers } = await world({ maxUpgradesPerMinute: 10 });
    for (let i = 0; i < 10; i++) {
      const c = await open(url, headers);
      c.ws.close();
      await c.closed;
    }
    expect(await upgradeStatus(origin, headers)).toBe(429);
    await h.addUser('olga', ['OPERATOR']);
    const other = await open(url, { cookie: await h.login('olga'), origin });
    other.ws.close();
  });

  test('open connections per user are limited', async () => {
    const { url, origin, headers } = await world({ maxPerUser: 3 });
    const open3 = [await open(url, headers), await open(url, headers), await open(url, headers)];
    expect(await upgradeStatus(origin, headers)).toBe(429);
    for (const c of open3) c.ws.close();
  });
});

describe('subscription authorization (SEC-015)', () => {
  test('a viewer never receives administration events, whatever it sends', async () => {
    const { h, url, origin, cookie } = await world();
    await h.addUser('vera', ['VIEWER']);
    const viewer = await open(url, { cookie: await h.login('vera'), origin });
    const admin = await open(url, { cookie, origin });
    // An administrator changes settings and users; only the administrator hears about it.
    await h.request('/api/settings', { method: 'PUT', cookie, json: { values: { keyMaxLifetimeDays: 20 } } });
    await h.request('/api/users', { method: 'POST', cookie, json: { username: 'newbie', displayName: 'N', password: 'a long enough passphrase here', roles: [] } });
    await Bun.sleep(50);
    const names = (c: Opened) => c.messages.filter((m) => m.type === 'event').map((m) => (m as { name: string }).name);
    expect(names(admin)).toContain('settings.changed');
    expect(names(viewer).filter((n) => ['settings.changed', 'user.changed', 'role.changed', 'api_key_request.changed'].includes(n))).toEqual([]);
    viewer.ws.close();
    admin.ws.close();
  });
});
