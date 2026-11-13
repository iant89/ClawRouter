/**
 * The console's live channel (spec §25, §31 WEBSOCKET /api/ws). Server-to-client
 * messages are JSON. They never carry secrets, prompts or completions: events
 * hold ids and states, and the console fetches details through the REST API with
 * its normal permission checks.
 */
import type { GatewayMetrics } from './gateway.ts';

export const REALTIME_PATH = '/api/ws';

/** Events forwarded to the console, each to users with the listed permission (null: any signed-in user). */
export const REALTIME_EVENTS = {
  'health.changed': null,
  'provider.changed': 'providers.read',
  'provider.status': 'providers.read',
  'provider.test.completed': 'providers.read',
  'provider.test.failed': 'providers.read',
  'model.changed': 'models.read',
  'model.availability': 'models.read',
  'routing.changed': 'routing.read',
  'ratelimits.changed': 'rate_limits.read',
  /** Sent only to the notification's recipients; carries the id only. */
  'notification.created': null,
  /** Filtered by the operation type's view permission (OPERATION_TYPES). */
  'operation.progress': null,
  /** Sent only to the user whose session ended. */
  'session.revoked': null,
} as const;

export type RealtimeEventName = keyof typeof REALTIME_EVENTS;

/** WebSocket close codes the console understands (4000–4999 are application-defined). */
export const REALTIME_CLOSE = {
  /** The session ended (signed out, revoked, expired): do not reconnect; sign in again. */
  SESSION_ENDED: 4401,
  /** The client could not keep up with messages: reconnect and resync. */
  TOO_SLOW: 4408,
  /** Too many open connections for this user. */
  TOO_MANY: 4429,
  /** The server is shutting down: reconnect later. */
  SERVER_STOPPING: 4503,
} as const;

/**
 * Gateway activity, sent at most once a second while requests are flowing,
 * instead of one message per request.
 */
export interface RealtimeActivity {
  type: 'activity';
  /** Requests that ended since the previous activity message. */
  completed: number;
  failed: number;
  rateLimited: number;
  /** Current gateway metrics, for users with `requests.read`. */
  metrics?: GatewayMetrics;
}

export type RealtimeServerMessage =
  | { type: 'hello'; user: { id: string; username: string }; permissions: string[]; heartbeatMs: number }
  | { type: 'event'; name: RealtimeEventName; data: Record<string, unknown>; at: string }
  | RealtimeActivity
  | { type: 'pong' };

export type RealtimeClientMessage = { type: 'ping' };
