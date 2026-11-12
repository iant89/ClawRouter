import { errors } from '@clawapi/core';
import type { NotificationService, Recipient } from '@clawapi/notifications';
import type { NotificationInfo, NotificationMeta } from '@clawapi/shared';
import type { Handler, RequestContext } from '../http/context.ts';
import { noContent, ok } from '../http/responses.ts';

/** The caller's own notifications: addressed to them or to a permission they hold now. */
const recipient = (ctx: RequestContext): Recipient => ({ userId: ctx.auth!.user.id, permissions: [...ctx.auth!.permissions] });

export function notificationsController(notifications: NotificationService) {
  const list: Handler = (ctx) => {
    const raw = ctx.url.searchParams.get('limit');
    const limit = raw === null ? 50 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw errors.validation([{ path: 'limit', message: 'must be an integer between 1 and 100' }]);
    const unreadOnly = ctx.url.searchParams.get('unread') === 'true';
    const { items, unread } = notifications.list(recipient(ctx), { limit, unreadOnly });
    return ok<NotificationInfo[]>(items, { meta: { unread } satisfies NotificationMeta });
  };

  const markRead: Handler = (ctx) => {
    if (!notifications.markRead(recipient(ctx), ctx.params.id ?? '')) throw errors.notFound('Notification not found.');
    return noContent();
  };

  const markAllRead: Handler = (ctx) => ok({ marked: notifications.markAllRead(recipient(ctx)) });

  const dismiss: Handler = (ctx) => {
    if (!notifications.dismiss(recipient(ctx), ctx.params.id ?? '')) throw errors.notFound('Notification not found.');
    return noContent();
  };

  return { list, markRead, markAllRead, dismiss };
}
