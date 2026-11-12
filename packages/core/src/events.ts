import type { HealthState, ProviderState } from '@clawapi/shared';
import type { Logger } from './logger.ts';

export type SessionRevokeReason = 'LOGOUT' | 'REVOKED' | 'USER_DISABLED' | 'PASSWORD_CHANGED';

/**
 * Every internal event and its payload (spec §25). Later phases extend this map
 * (provider.status, request.completed, ...). Payloads must never carry secrets:
 * some are forwarded to WebSocket clients.
 */
export interface EventMap {
  'health.changed': { previous: HealthState; current: HealthState; checkedAt: string };
  'settings.changed': { key: string };
  'session.revoked': { sessionId: string; userId: string; reason: SessionRevokeReason };
  'user.signed_in': { userId: string };
  'user.roles_changed': { userId: string; roles: string[] };
  /** A username was blocked after repeated failed sign-ins (emitted once per block). */
  'auth.login_throttled': { username: string; ip: string | null; scope: 'username' | 'ip'; retryAfterSeconds: number };
  'provider.changed': { providerId: string; action: 'created' | 'updated' | 'deleted' | 'enabled' | 'disabled' | 'credential' };
  'provider.status': { providerId: string; name: string; previous: ProviderState; current: ProviderState; detail: string | null };
  'provider.test.started': { providerId: string };
  'provider.test.completed': { providerId: string; status: ProviderState; latencyMs: number | null };
  'provider.test.failed': { providerId: string; status: ProviderState; message: string };
  'notification.created': { id: string; userId: string | null; audiencePermission: string | null };
}

export type EventName = keyof EventMap;
export type EventListener<K extends EventName> = (payload: EventMap[K]) => void | Promise<void>;

export interface EventBus {
  on<K extends EventName>(name: K, listener: EventListener<K>): () => void;
  emit<K extends EventName>(name: K, payload: EventMap[K]): void;
  listenerCount(name: EventName): number;
}

/**
 * In-process typed event bus. A failing listener is logged and never affects
 * the emitter or other listeners.
 */
export function createEventBus(log?: Logger): EventBus {
  const listeners = new Map<EventName, Set<EventListener<never>>>();

  const report = (name: EventName, error: unknown) =>
    log?.error('event listener failed', { component: 'events', event: name, error });

  return {
    on(name, listener) {
      let set = listeners.get(name);
      if (!set) listeners.set(name, (set = new Set()));
      set.add(listener as EventListener<never>);
      return () => {
        set.delete(listener as EventListener<never>);
      };
    },
    emit(name, payload) {
      for (const listener of listeners.get(name) ?? []) {
        try {
          const result = (listener as EventListener<typeof name>)(payload);
          if (result instanceof Promise) result.catch((error: unknown) => report(name, error));
        } catch (error) {
          report(name, error);
        }
      }
    },
    listenerCount: (name) => listeners.get(name)?.size ?? 0,
  };
}
