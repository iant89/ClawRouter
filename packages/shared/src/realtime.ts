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
  'role.changed': 'roles.read',
  'user.changed': 'users.read',
  'settings.changed': 'settings.read',
  /** Key request list changes: approvers. (Requesters hear through their notifications.) */
  'api_key_request.changed': 'api_keys.write',
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
  /** Nothing (not even a ping) arrived for three heartbeats: reconnect. */
  IDLE: 4410,
  /** The server is shutting down: reconnect later. */
  SERVER_STOPPING: 4503,
  /** Standard codes: a message the protocol does not have (1008), a binary frame (1003), too large (1009). */
  POLICY_VIOLATION: 1008,
  UNSUPPORTED_DATA: 1003,
  TOO_LARGE: 1009,
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
