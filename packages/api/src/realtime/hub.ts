import { newId, type EventBus, type EventMap, type Logger } from '@clawrouter/core';
import type { AuthService } from '@clawrouter/authentication';
import type { AuthorizationService } from '@clawrouter/authorization';
import {
  isOperationType, OPERATION_TYPES, REALTIME_CLOSE, REALTIME_EVENTS, type GatewayMetrics, type RealtimeEventName, type RealtimeServerMessage,
} from '@clawrouter/shared';
import { readSessionToken, type SessionCookieConfig } from '../http/session.ts';

/** What the server keeps per connection. The token never leaves the server. */
export interface SocketData {
  connId: string;
  userId: string;
  username: string;
  sessionId: string;
  token: string;
  permissions: Set<string>;
}

/** The part of Bun's ServerWebSocket the hub uses (fakes implement it in tests). */
export interface RealtimeSocket {
  data: SocketData;
  send(message: string): unknown;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
}

export interface RealtimeOptions {
  events: EventBus;
  auth: AuthService;
  authz: AuthorizationService;
  cookie: SessionCookieConfig;
  /** Current gateway metrics, included in activity messages for users with `requests.read`. */
  metrics?: () => GatewayMetrics;
  log?: Logger;
  now?: () => Date;
  /** Open connections allowed per user (tabs) and in total. */
  maxPerUser?: number;
  maxTotal?: number;
  /** A connection whose unsent data exceeds this is closed (slow consumer). */
  maxBufferedBytes?: number;
  /** How often sessions behind open connections are re-checked. */
  sessionCheckMs?: number;
  /** How often coalesced gateway activity is sent. */
  activityMs?: number;
}

export type RealtimeHub = ReturnType<typeof createRealtimeHub>;

const MAX_CLIENT_MESSAGE = 1024;
const HEARTBEAT_MS = 25_000;
/** Users with any of these see gateway activity. */
const ACTIVITY_PERMISSIONS = ['requests.read', 'usage.read', 'rate_limits.read'];

/**
 * The console's live channel (spec §25): a session-authenticated WebSocket that
 * forwards internal events to the users allowed to see them.
 *
 * - The upgrade needs a live console session and a same-origin request
 *   (prevents cross-site WebSocket hijacking with the session cookie).
 * - Every event is filtered by the receiving user's permissions; notifications
 *   go only to their recipients, and session events only to that user.
 * - Gateway request events are coalesced into one activity message per second.
 * - Sessions are re-checked periodically and on revocation; a connection whose
 *   session ended is closed with 4401. Role changes refresh the permissions.
 * - Slow consumers are disconnected instead of buffering without bound.
 */
export function createRealtimeHub(options: RealtimeOptions) {
  const { events, auth, authz, log } = options;
  const now = options.now ?? (() => new Date());
  const maxPerUser = options.maxPerUser ?? 20;
  const maxTotal = options.maxTotal ?? 2000;
  const maxBuffered = options.maxBufferedBytes ?? 1024 * 1024;
  const sockets = new Set<RealtimeSocket>();
  const unsubscribe: (() => void)[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  let activity = { completed: 0, failed: 0, rateLimited: 0 };

  function send(ws: RealtimeSocket, message: RealtimeServerMessage) {
    if (ws.getBufferedAmount() > maxBuffered) {
      log?.warn('realtime client too slow; disconnecting', { component: 'realtime', userId: ws.data.userId });
      close(ws, REALTIME_CLOSE.TOO_SLOW, 'too slow');
      return;
    }
    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      log?.debug('realtime send failed', { component: 'realtime', error });
    }
  }

  function close(ws: RealtimeSocket, code: number, reason: string) {
    sockets.delete(ws);
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  const hello = (ws: RealtimeSocket): RealtimeServerMessage => ({
    type: 'hello', user: { id: ws.data.userId, username: ws.data.username }, permissions: [...ws.data.permissions].sort(), heartbeatMs: HEARTBEAT_MS,
  });

  const event = (name: RealtimeEventName, data: Record<string, unknown>): RealtimeServerMessage => ({ type: 'event', name, data, at: now().toISOString() });

  /** Forwards an event to every connection whose user holds the permission. */
  function forward<K extends Exclude<RealtimeEventName, 'notification.created' | 'session.revoked' | 'operation.progress'>>(name: K) {
    unsubscribe.push(events.on(name, (payload: EventMap[K]) => {
      const permission = REALTIME_EVENTS[name];
      for (const ws of sockets) {
        if (permission === null || ws.data.permissions.has(permission)) send(ws, event(name, payload as unknown as Record<string, unknown>));
      }
    }));
  }

  forward('health.changed');
  forward('provider.changed');
  forward('provider.status');
  forward('provider.test.completed');
  forward('provider.test.failed');
  forward('model.changed');
  forward('model.availability');
  forward('routing.changed');
  forward('ratelimits.changed');

  // Operations: to users who may see operations of that type.
  unsubscribe.push(events.on('operation.progress', (payload) => {
    if (!isOperationType(payload.type)) return;
    const permission = OPERATION_TYPES[payload.type].view;
    for (const ws of sockets) if (ws.data.permissions.has(permission)) send(ws, event('operation.progress', payload));
  }));

  // Notifications: only to their recipients, and only the id (the list API applies its own checks).
  unsubscribe.push(events.on('notification.created', ({ id, userId, audiencePermission }) => {
    for (const ws of sockets) {
      const mine = userId !== null ? ws.data.userId === userId : audiencePermission !== null && ws.data.permissions.has(audiencePermission);
      if (mine) send(ws, event('notification.created', { id }));
    }
  }));

  // A session that ends is told so, then disconnected; the user's other sessions learn which one ended.
  unsubscribe.push(events.on('session.revoked', ({ sessionId, userId, reason }) => {
    for (const ws of [...sockets]) {
      if (ws.data.userId !== userId) continue;
      send(ws, event('session.revoked', { sessionId, reason, current: ws.data.sessionId === sessionId }));
      if (ws.data.sessionId === sessionId) close(ws, REALTIME_CLOSE.SESSION_ENDED, 'session ended');
    }
  }));

  // New roles: recompute permissions for that user's connections and say hello again.
  unsubscribe.push(events.on('user.roles_changed', ({ userId }) => {
    const permissions = authz.principalFor(userId).permissions;
    for (const ws of sockets) {
      if (ws.data.userId !== userId) continue;
      ws.data.permissions = new Set(permissions);
      send(ws, hello(ws));
    }
  }));

  // Gateway traffic: count now, send at most once per activity interval.
  unsubscribe.push(events.on('request.completed', () => { activity.completed += 1; }));
  unsubscribe.push(events.on('request.failed', () => { activity.failed += 1; }));
  unsubscribe.push(events.on('ratelimit.exceeded', () => { activity.rateLimited += 1; }));

  return {
    /**
     * Checks an upgrade request. Returns the connection data to upgrade with, or
     * the response that refuses it.
     */
    authorize(request: Request): { ok: true; data: SocketData } | { ok: false; response: Response } {
      const refuse = (status: number, message: string) => ({ ok: false as const, response: Response.json({ error: { code: status === 401 ? 'AUTHENTICATION_ERROR' : status === 429 ? 'RATE_LIMITED' : 'AUTHORIZATION_ERROR', message } }, { status }) });
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return refuse(400, 'Expected a WebSocket upgrade.');
      // Browsers always send Origin on WebSocket requests; a different one is another site using the cookie.
      const origin = request.headers.get('origin');
      const self = new URL(request.url);
      const host = request.headers.get('host') ?? self.host;
      if (!origin || !URL.canParse(origin) || new URL(origin).host !== host) {
        log?.warn('realtime connection from another origin refused', { component: 'realtime', origin });
        return refuse(403, 'Cross-origin WebSocket connections are not allowed.');
      }
      const token = readSessionToken(request, options.cookie);
      const resolved = token ? auth.resolve(token) : null;
      if (!token || !resolved) return refuse(401, 'Sign in first.');
      let mine = 0;
      for (const ws of sockets) if (ws.data.userId === resolved.user.id) mine += 1;
      if (mine >= maxPerUser || sockets.size >= maxTotal) return refuse(429, 'Too many open connections.');
      return {
        ok: true,
        data: {
          connId: newId(), userId: resolved.user.id, username: resolved.user.username, sessionId: resolved.sessionId, token,
          permissions: new Set(authz.principalFor(resolved.user.id).permissions),
        },
      };
    },

    open(ws: RealtimeSocket) {
      sockets.add(ws);
      send(ws, hello(ws));
      log?.debug('realtime connection opened', { component: 'realtime', userId: ws.data.userId, connections: sockets.size });
    },

    message(ws: RealtimeSocket, raw: string | Buffer) {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      if (text.length > MAX_CLIENT_MESSAGE) return close(ws, 1009, 'message too large');
      try {
        const msg = JSON.parse(text) as { type?: unknown };
        if (msg.type === 'ping') send(ws, { type: 'pong' });
      } catch {
        // Clients only send pings; anything else is ignored.
      }
    },

    close(ws: RealtimeSocket) {
      sockets.delete(ws);
    },

    /** Sends the coalesced gateway activity, if anything happened. */
    flushActivity() {
      if (!activity.completed && !activity.failed && !activity.rateLimited) return;
      const counts = activity;
      activity = { completed: 0, failed: 0, rateLimited: 0 };
      let metrics: GatewayMetrics | undefined;
      for (const ws of sockets) {
        if (!ACTIVITY_PERMISSIONS.some((p) => ws.data.permissions.has(p))) continue;
        const withMetrics = ws.data.permissions.has('requests.read') && options.metrics;
        if (withMetrics) metrics ??= options.metrics!();
        send(ws, { type: 'activity', ...counts, ...(withMetrics ? { metrics } : {}) });
      }
    },

    /** Closes connections whose session has ended (expired, revoked, user disabled). Not user activity. */
    checkSessions() {
      for (const ws of [...sockets]) {
        if (!auth.resolve(ws.data.token, { touch: false })) close(ws, REALTIME_CLOSE.SESSION_ENDED, 'session ended');
      }
    },

    start() {
      const a = setInterval(() => this.flushActivity(), options.activityMs ?? 1000);
      const s = setInterval(() => this.checkSessions(), options.sessionCheckMs ?? 30_000);
      a.unref();
      s.unref();
      timers.push(a, s);
    },

    stop() {
      for (const t of timers) clearInterval(t);
      for (const off of unsubscribe) off();
      for (const ws of [...sockets]) close(ws, REALTIME_CLOSE.SERVER_STOPPING, 'server stopping');
    },

    get size() {
      return sockets.size;
    },
  };
}
