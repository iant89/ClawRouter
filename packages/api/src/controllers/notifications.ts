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

import { errors } from '@clawrouter/core';
import type { NotificationService, Recipient } from '@clawrouter/notifications';
import type { NotificationInfo, NotificationMeta } from '@clawrouter/shared';
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
