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

import { Button, NotificationCenter } from '@enterprise-ui/react';
import { useRouter } from '../../app/router.tsx';
import { formatRelative } from '../../services/format.ts';
import { displayTitle } from './notification-utils.ts';
import { useNotifications } from './NotificationsContext.tsx';

/**
 * Header notifications popover: the ENTERPRISE-UI NotificationCenter, plus
 * "mark all as read" and links to the related page (composition, not a new component).
 */
export function NotificationsPanel() {
  const { items, loading, error, markRead, markAllRead, dismiss, unread } = useNotifications();
  const { navigate } = useRouter();
  const links = items.filter((n) => n.link && !n.read);
  return (
    <div style={{ display: 'grid', gap: 'var(--eui-space-2, 0.5rem)', padding: 'var(--eui-space-3, 0.75rem)', width: 'min(24rem, calc(100vw - 2rem))', maxHeight: '70vh', overflowY: 'auto', boxSizing: 'border-box' }}>
      <NotificationCenter
        notifications={items.map((n) => ({ id: n.id, title: displayTitle(n), description: n.body ?? undefined, timestamp: n.createdAt, read: n.read }))}
        loading={loading && items.length === 0}
        error={error ?? undefined}
        onMarkRead={(id) => void markRead(id)}
        onDismiss={(id) => void dismiss(id)}
        formatTimestamp={(ts) => formatRelative(ts)}
      />
      {links.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eui-space-1, 0.25rem)' }}>
          {[...new Set(links.map((n) => n.link!))].map((link) => (
            <Button key={link} size="sm" variant="tertiary" onClick={() => navigate(link)}>Open {link.slice(1)}</Button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button size="sm" variant="tertiary" disabled={unread === 0} onClick={() => void markAllRead()}>Mark all as read</Button>
      </div>
    </div>
  );
}
