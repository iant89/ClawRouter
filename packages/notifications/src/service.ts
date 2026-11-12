import { newId, type EventBus, type Logger } from '@clawapi/core';
import type { HealthState, NotificationInfo, NotificationSeverity } from '@clawapi/shared';
import type { NotificationRepository, Recipient } from './repository.ts';

export interface NotifyInput {
  /** Exactly one of `userId` / `audiencePermission`. */
  userId?: string;
  audiencePermission?: string;
  severity: NotificationSeverity;
  title: string;
  body?: string;
  link?: string;
  source: string;
}

export type NotificationService = ReturnType<typeof createNotificationService>;

const HEALTH_LABEL: Record<HealthState, string> = {
  HEALTHY: 'Healthy', DEGRADED: 'Degraded', OFFLINE: 'Offline', DISABLED: 'Disabled', UNKNOWN: 'Unknown',
};
const ROLE_LABEL: Record<string, string> = { ADMIN: 'Administrator', OPERATOR: 'Operator', VIEWER: 'Viewer' };

/** Kept for 30 days, then purged. */
export const NOTIFICATION_RETENTION_DAYS = 30;

/**
 * Console notifications. Content must be safe to show to every recipient:
 * never secrets, never request payloads.
 */
export function createNotificationService(options: {
  repo: NotificationRepository;
  events?: EventBus;
  log?: Logger;
  now?: () => Date;
}) {
  const { repo, events, log } = options;
  const now = options.now ?? (() => new Date());

  const service = {
    notify(input: NotifyInput): string {
      if ((input.userId === undefined) === (input.audiencePermission === undefined)) {
        throw new Error('notify() needs exactly one of userId or audiencePermission');
      }
      const id = newId();
      repo.insert({
        id,
        userId: input.userId ?? null,
        audiencePermission: input.audiencePermission ?? null,
        severity: input.severity,
        title: input.title.slice(0, 200),
        body: input.body?.slice(0, 1000) ?? null,
        link: input.link && input.link.startsWith('/') && !input.link.startsWith('//') ? input.link : null,
        source: input.source,
        createdAt: now().toISOString(),
      });
      events?.emit('notification.created', { id, userId: input.userId ?? null, audiencePermission: input.audiencePermission ?? null });
      return id;
    },

    list(recipient: Recipient, options: { limit?: number; unreadOnly?: boolean } = {}): { items: NotificationInfo[]; unread: number } {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
      return { items: repo.listFor(recipient, { limit, unreadOnly: options.unreadOnly }), unread: repo.countUnread(recipient) };
    },

    markRead: (recipient: Recipient, id: string) => repo.markRead(recipient, id, now().toISOString()),
    markAllRead: (recipient: Recipient) => repo.markAllRead(recipient, now().toISOString()),
    dismiss: (recipient: Recipient, id: string) => repo.dismiss(recipient, id, now().toISOString()),
    purgeOld: () => repo.purge(new Date(now().getTime() - NOTIFICATION_RETENTION_DAYS * 86_400_000).toISOString()),

    /** Turns internal events into notifications. Returns an unsubscribe function. */
    subscribe(bus: EventBus): () => void {
      const safely = <T>(fn: (payload: T) => void) => (payload: T) => {
        try {
          fn(payload);
        } catch (error) {
          log?.error('notification producer failed', { component: 'notifications', error });
        }
      };
      const offs = [
        bus.on('health.changed', safely(({ previous, current, checkedAt }) => {
          if (previous === 'UNKNOWN' && current === 'HEALTHY') return; // normal startup
          const severity: NotificationSeverity = current === 'OFFLINE' ? 'ERROR' : current === 'HEALTHY' ? 'SUCCESS' : current === 'DEGRADED' ? 'WARNING' : 'INFO';
          service.notify({
            audiencePermission: 'health.read',
            severity,
            title: current === 'HEALTHY' ? 'Platform health recovered' : `Platform health: ${HEALTH_LABEL[current]}`,
            body: `Changed from ${HEALTH_LABEL[previous]} to ${HEALTH_LABEL[current]} at ${new Date(checkedAt).toLocaleTimeString('en-GB')}.`,
            link: '/health',
            source: 'health.changed',
          });
        })),
        bus.on('provider.status', safely(({ providerId, name, previous, current, detail }) => {
          // Admin actions (enable/disable, edits) and first checks are not news; failures and recoveries are.
          const failing = current === 'OFFLINE' || current === 'DEGRADED';
          const recovered = current === 'HEALTHY' && (previous === 'OFFLINE' || previous === 'DEGRADED');
          if (!failing && !recovered) return;
          if (failing && previous === current) return;
          service.notify({
            audiencePermission: 'providers.read',
            severity: recovered ? 'SUCCESS' : current === 'OFFLINE' ? 'ERROR' : 'WARNING',
            title: recovered ? `Provider ${name} recovered` : `Provider ${name} is ${current === 'OFFLINE' ? 'offline' : 'degraded'}`,
            body: detail ?? undefined,
            link: '/providers',
            source: `provider.status:${providerId}`,
          });
        })),
        bus.on('user.roles_changed', safely(({ userId, roles }) => {
          service.notify({
            userId,
            severity: 'INFO',
            title: 'Your roles changed',
            body: roles.length ? `You now have: ${roles.map((r) => ROLE_LABEL[r] ?? r).join(', ')}.` : 'You no longer have any role. Ask an administrator if this is unexpected.',
            source: 'user.roles_changed',
          });
        })),
        bus.on('auth.login_throttled', safely(({ username, ip, scope, retryAfterSeconds }) => {
          const minutes = Math.max(1, Math.round(retryAfterSeconds / 60));
          service.notify({
            audiencePermission: 'audit.read',
            severity: 'WARNING',
            title: 'Sign-in blocked after repeated failures',
            body: scope === 'username'
              ? `Sign-in as "${username}" is blocked for ${minutes} min after repeated wrong passwords${ip ? ` (last attempt from ${ip})` : ''}.`
              : `Sign-in from ${ip ?? 'an unknown address'} is blocked for ${minutes} min after repeated failures.`,
            link: '/audit',
            source: 'auth.login_throttled',
          });
        })),
      ];
      return () => offs.forEach((off) => off());
    },
  };
  return service;
}
