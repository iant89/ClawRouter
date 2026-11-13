import { describe, expect, test } from 'bun:test';
import type { RealtimeServerMessage } from '@clawrouter/shared';
import { createRealtimeHub, type RealtimeSocket, type SocketData } from '../src/realtime/hub.ts';
import { createHarness, type Harness } from '../../../tests/support/harness.ts';

class FakeSocket implements RealtimeSocket {
  sent: RealtimeServerMessage[] = [];
  closed: { code?: number; reason?: string } | null = null;
  buffered = 0;
  constructor(public data: SocketData) {}
  send(message: string) {
    this.sent.push(JSON.parse(message) as RealtimeServerMessage);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  getBufferedAmount() {
    return this.buffered;
  }
  /** Event names, without the notifications the notification service derives from them. */
  events() {
    return this.allEvents().filter((n) => n !== 'notification.created');
  }
  allEvents() {
    return this.sent.filter((m): m is Extract<RealtimeServerMessage, { type: 'event' }> => m.type === 'event').map((m) => m.name);
  }
}

const ORIGIN = 'http://clawrouter.test';
const upgradeRequest = (cookie: string | null, origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}/api/ws`, { headers: { upgrade: 'websocket', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) } });

function setup(h: Harness, options: Partial<Parameters<typeof createRealtimeHub>[0]> = {}) {
  const hub = createRealtimeHub({ events: h.events, auth: h.auth, authz: h.authz, cookie: { secure: false }, metrics: () => h.gateway.metrics.snapshot(), now: h.clock.now, ...options });
  const connect = (cookie: string) => {
    const check = hub.authorize(upgradeRequest(cookie));
    if (!check.ok) throw new Error(`refused: ${check.response.status}`);
    const ws = new FakeSocket(check.data);
    hub.open(ws);
    return ws;
  };
  return { hub, connect };
}

describe('upgrade', () => {
  test('needs a WebSocket upgrade, the same origin and a live session', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const { hub } = setup(h);
    expect((hub.authorize(new Request(`${ORIGIN}/api/ws`, { headers: { cookie: admin, origin: ORIGIN } })) as { response: Response }).response.status).toBe(400);
    const status = (cookie: string | null, origin?: string | null) => {
      const r = hub.authorize(upgradeRequest(cookie, origin));
      return r.ok ? 101 : r.response.status;
    };
    expect(status(null)).toBe(401);
    expect(status('clawrouter_session=forged')).toBe(401);
    expect(status(admin, 'https://evil.example')).toBe(403);
    expect(status(admin, null)).toBe(403);
    expect(status(admin)).toBe(101);
  });

  test('the first message says who you are and what you may see; the token is never sent', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const ws = setup(h).connect(admin);
    expect(ws.sent[0]).toMatchObject({ type: 'hello', user: { username: 'admin' }, heartbeatMs: 25_000 });
    expect((ws.sent[0] as { permissions: string[] }).permissions).toContain('providers.read');
    expect(JSON.stringify(ws.sent)).not.toContain(admin.split('=')[1]!);
  });

  test('connections per user are limited', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const { hub, connect } = setup(h, { maxPerUser: 2 });
    connect(admin);
    connect(admin);
    const third = hub.authorize(upgradeRequest(admin));
    expect(third.ok ? 0 : third.response.status).toBe(429);
  });
});

describe('events are filtered by permission', () => {
  test('provider, routing and model events reach only users who may read them; health reaches everyone', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    await h.addUser('nobody', []);
    const { connect } = setup(h);
    const a = connect(admin);
    const n = connect(await h.login('nobody'));
    h.events.emit('provider.status', { providerId: 'p', name: 'OpenAI', previous: 'UNKNOWN', current: 'HEALTHY', detail: null });
    h.events.emit('routing.changed', { version: 2, updatedBy: 'x' });
    h.events.emit('health.changed', { previous: 'HEALTHY', current: 'DEGRADED', checkedAt: '2026-01-01T00:00:00Z' });
    // Internal-only events are never forwarded.
    h.events.emit('provider.models_listed', { providerId: 'p', models: [] });
    h.events.emit('auth.login_throttled', { username: 'x', ip: '203.0.113.9', scope: 'ip', retryAfterSeconds: 10 });
    expect(a.events()).toEqual(['provider.status', 'routing.changed', 'health.changed']);
    expect(n.events()).toEqual(['health.changed']);
  });

  test('notifications go only to their recipients, with the id only', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const op = await h.addUser('op', ['OPERATOR']);
    const { connect } = setup(h);
    const a = connect(admin);
    const o = connect(await h.login('op'));
    h.notifications.notify({ userId: op.id, title: 'for op only', body: 'secret-ish text', severity: 'INFO', source: 'test' });
    expect(a.allEvents()).toEqual([]);
    expect(o.sent.at(-1)).toMatchObject({ type: 'event', name: 'notification.created', data: { id: expect.any(String) } });
    expect(JSON.stringify(o.sent)).not.toContain('secret-ish text');
    h.notifications.notify({ audiencePermission: 'health.read', title: 'health', body: '', severity: 'WARNING', source: 'test' });
    expect(a.allEvents()).toEqual(['notification.created']);
  });

  test('new roles take effect on open connections', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const user = await h.addUser('later', []);
    const { connect } = setup(h);
    const ws = connect(await h.login('later'));
    h.events.emit('routing.changed', { version: 2, updatedBy: null });
    expect(ws.events()).toEqual([]);
    const res = await h.request(`/api/users/${user.id}/roles`, { method: 'PUT', cookie: admin, json: { roles: ['VIEWER'] } });
    expect(res.status).toBe(200);
    expect(ws.sent.at(-1)).toMatchObject({ type: 'hello', permissions: expect.arrayContaining(['routing.read']) });
    h.events.emit('routing.changed', { version: 3, updatedBy: null });
    expect(ws.events()).toEqual(['routing.changed']);
  });
});

describe('sessions', () => {
  test('a revoked session is told and disconnected; the same user\'s other sessions are told which one ended', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const other = await h.login();
    const { hub, connect } = setup(h);
    const a = connect(admin);
    const b = connect(other);
    const res = await h.request('/api/auth/logout', { method: 'POST', cookie: other });
    expect(res.status).toBe(204);
    expect(b.closed?.code).toBe(4401);
    expect(b.sent.at(-1)).toMatchObject({ name: 'session.revoked', data: { current: true } });
    expect(a.closed).toBeNull();
    expect(a.sent.at(-1)).toMatchObject({ name: 'session.revoked', data: { current: false } });
    expect(hub.size).toBe(1);
  });

  test('expired sessions are closed by the periodic check, which does not keep them alive', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const { hub, connect } = setup(h);
    const ws = connect(admin);
    for (let i = 0; i < 7; i++) {
      h.clock.advance(10 * 60_000);
      hub.checkSessions();
    }
    // 70 minutes of an open socket without user activity: the 60-minute idle limit applies.
    expect(ws.closed?.code).toBe(4401);
    expect((await h.request('/api/auth/session', { cookie: admin })).status).toBe(401);
  });

  test('stop closes every connection with "server stopping"', async () => {
    const h = createHarness();
    const { hub, connect } = setup(h);
    const ws = connect(await h.completeSetup());
    hub.stop();
    expect(ws.closed?.code).toBe(4503);
  });
});

describe('gateway activity', () => {
  test('request events are coalesced and sent to users who may see activity, metrics only with requests.read', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    await h.addUser('nobody', []);
    const { hub, connect } = setup(h);
    const a = connect(admin);
    const n = connect(await h.login('nobody'));
    for (let i = 0; i < 50; i++) h.events.emit('request.completed', { requestId: `r${i}`, apiKeyId: 'k', model: 'm', modelRef: 'p/m', providerId: 'p', stream: false, durationMs: 1, attempts: 1, failovers: 0, usage: { inputTokens: 1, outputTokens: 1, source: 'provider' } });
    h.events.emit('request.failed', { requestId: 'x', apiKeyId: 'k', model: 'm', stream: false, durationMs: 1, attempts: 1, code: 'PROVIDER_ERROR', status: 502 });
    h.events.emit('ratelimit.exceeded', { scope: 'ip', subject: '203.0.113.9', kind: 'invalid_keys', limit: 20, retryAfterSeconds: 5, requestId: null });
    expect(a.sent.filter((m) => m.type === 'activity')).toHaveLength(0);
    hub.flushActivity();
    hub.flushActivity(); // nothing new: nothing sent
    const activity = a.sent.filter((m) => m.type === 'activity');
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ completed: 50, failed: 1, rateLimited: 1, metrics: { totalRequests: 0 } });
    expect(JSON.stringify(a.sent)).not.toContain('203.0.113.9');
    expect(n.sent.filter((m) => m.type === 'activity')).toHaveLength(0);
  });

  test('a client that cannot keep up is disconnected instead of buffering', async () => {
    const h = createHarness();
    const { hub, connect } = setup(h);
    const ws = connect(await h.completeSetup());
    ws.buffered = 2 * 1024 * 1024;
    h.events.emit('health.changed', { previous: 'HEALTHY', current: 'DEGRADED', checkedAt: '2026-01-01T00:00:00Z' });
    expect(ws.closed?.code).toBe(4408);
    expect(hub.size).toBe(0);
  });

  test('pings get pongs; oversized or unknown messages are not acted on', async () => {
    const h = createHarness();
    const { hub, connect } = setup(h);
    const ws = connect(await h.completeSetup());
    hub.message(ws, JSON.stringify({ type: 'ping' }));
    expect(ws.sent.at(-1)).toEqual({ type: 'pong' });
    hub.message(ws, '{"type":"subscribe","all":true}');
    hub.message(ws, 'not json');
    expect(ws.sent.at(-1)).toEqual({ type: 'pong' });
    hub.message(ws, 'x'.repeat(2000));
    expect(ws.closed?.code).toBe(1009);
  });
});

describe('operations', () => {
  test('operation progress reaches users who may see that operation type', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    await h.addUser('nobody', []);
    const { connect } = setup(h);
    const a = connect(admin);
    const n = connect(await h.login('nobody'));
    h.events.emit('operation.progress', { id: 'o1', type: 'provider.test', targetId: 'p', status: 'RUNNING', progress: 40, message: 'Contacting the provider' });
    h.events.emit('operation.progress', { id: 'o2', type: 'unknown.type', targetId: null, status: 'RUNNING', progress: 0, message: null });
    expect(a.events()).toEqual(['operation.progress']);
    expect(n.events()).toEqual([]);
  });
});
