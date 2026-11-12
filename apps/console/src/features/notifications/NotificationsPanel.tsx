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
