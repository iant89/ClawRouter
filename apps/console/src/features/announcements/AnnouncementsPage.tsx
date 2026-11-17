import { useState } from 'react';
import { AlertDialog, Button, MessageStrip, OverflowMenu, Page, RefreshControl, StatusIndicator, Table, Text, useToast, type TableColumn } from '@enterprise-ui/react';
import { ANNOUNCEMENT_CHANNEL_LABELS, ANNOUNCEMENT_FREQUENCY_LABELS, type AnnouncementInfo } from '@clawrouter/shared';
import { useResource } from '../../hooks/useResource.ts';
import { deleteAnnouncement, fetchAnnouncements, updateAnnouncement } from '../../services/notices.ts';
import { formatRelative } from '../../services/format.ts';
import { useRouter } from '../../app/router.tsx';
import { usePermissions } from '../auth/AuthContext.tsx';
import { AnnouncementDialog } from './AnnouncementDialog.tsx';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

/** Where an announcement stands now: shown as text and an icon, never colour alone. */
function stateOf(a: AnnouncementInfo, now = Date.now()): { label: string; tone: 'success' | 'neutral' | 'information' } {
  if (!a.enabled) return { label: 'Off', tone: 'neutral' };
  if (a.startsAt && Date.parse(a.startsAt) > now) return { label: 'Scheduled', tone: 'information' };
  return { label: 'Active', tone: 'success' };
}

/**
 * Administration → Announcements (owner request, 2026-11-17): messages for the
 * people using ClawRouter's API, sent with gateway responses on a schedule.
 */
export function AnnouncementsPage() {
  const toast = useToast();
  const { navigate } = useRouter();
  const canSettings = usePermissions().can('settings.read');
  const { data, error, loading, lastUpdated, reload } = useResource(fetchAnnouncements);
  const [editing, setEditing] = useState<AnnouncementInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<AnnouncementInfo | null>(null);

  const toggle = async (a: AnnouncementInfo) => {
    try {
      await updateAnnouncement(a.id, { enabled: !a.enabled });
      toast.show({ tone: 'success', title: a.enabled ? 'Announcement turned off' : 'Announcement turned on' });
      reload();
    } catch (err) {
      toast.show({ tone: 'error', title: 'Could not change it', description: err instanceof Error ? err.message : undefined, duration: 10_000 });
    }
  };
  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteAnnouncement(deleting.id);
      toast.show({ tone: 'success', title: 'Announcement deleted' });
      setDeleting(null);
      reload();
    } catch (err) {
      toast.show({ tone: 'error', title: 'Could not delete', description: err instanceof Error ? err.message : undefined, duration: 10_000 });
    }
  };

  const columns: TableColumn<AnnouncementInfo>[] = [
    { id: 'message', header: 'Message', rowHeader: true, wrap: true, accessor: 'message', cell: (a) => <span><span aria-hidden="true">{a.icon}</span> {a.message}</span> },
    { id: 'state', header: 'State', accessor: (a) => stateOf(a).label, cell: (a) => { const s = stateOf(a); return <StatusIndicator tone={s.tone} size="sm">{s.label}</StatusIndicator>; } },
    { id: 'frequency', header: 'How often', wrap: true, accessor: 'frequency', cell: (a) => ANNOUNCEMENT_FREQUENCY_LABELS[a.frequency] },
    { id: 'channel', header: 'Where', wrap: true, accessor: 'channel', cell: (a) => ANNOUNCEMENT_CHANNEL_LABELS[a.channel] },
    { id: 'window', header: 'Starts / expires', wrap: true, accessor: (a) => a.expiresAt ?? '', cell: (a) => <Text size="sm">{a.startsAt ? when(a.startsAt) : 'Now'}<br />{a.expiresAt ? `until ${when(a.expiresAt)}` : 'until deleted'}</Text> },
    { id: 'reach', header: 'Reached', align: 'end', accessor: 'reachedUsers', cell: (a) => <span title={`${a.deliveries.toLocaleString()} times in total`}>{a.reachedUsers.toLocaleString()} user{a.reachedUsers === 1 ? '' : 's'}</span> },
    { id: 'by', header: 'Created', wrap: true, accessor: 'createdAt', cell: (a) => <Text size="sm">{formatRelative(a.createdAt)}{a.createdBy ? ` by ${a.createdBy}` : ''}</Text> },
    {
      id: 'actions', header: 'Actions', align: 'end',
      cell: (a) => (
        <OverflowMenu label={`Actions for ${a.message.slice(0, 40)}`}
          items={[{ id: 'edit', label: 'Edit' }, { id: 'toggle', label: a.enabled ? 'Turn off' : 'Turn on' }, { id: 'delete', label: 'Delete' }]}
          onAction={(id) => (id === 'edit' ? setEditing(a) : id === 'toggle' ? void toggle(a) : setDeleting(a))} />
      ),
    },
  ];

  return (
    <Page
      title="Announcements"
      subtitle="Messages for the people and apps using ClawRouter's API, sent with their responses"
      actions={<>
        <Button variant="primary" icon="add" onClick={() => setCreating(true)}>New announcement</Button>
        <RefreshControl onRefresh={reload} refreshing={loading} lastUpdated={lastUpdated} intervals={[]} />
      </>}
    >
      {error && <MessageStrip tone="error" title="Cannot load announcements">{error}</MessageStrip>}
      <MessageStrip tone="information">
        Each announcement goes in the <span className="claw-mono">X-ClawRouter-Notices</span> header, at the start of chat replies, or both, as the settings allow.
        &ldquo;Once&rdquo; and &ldquo;a day&rdquo; count per user: all of a user&rsquo;s API keys share them.
        {canSettings && <> <Button size="sm" variant="tertiary" onClick={() => navigate('/settings?tab=notices')}>Notice settings</Button></>}
      </MessageStrip>
      <Table
        caption={`Announcements (${data?.length ?? 0})`}
        columns={columns}
        data={data ?? []}
        getRowId={(a) => a.id}
        getRowLabel={(a) => a.message}
        onRowClick={(a) => setEditing(a)}
        loading={loading && !data}
        emptyState="No announcements. Create one to tell API users about maintenance, new models or changes."
      />
      <Text size="sm" tone="secondary">Expired announcements delete themselves. At most 20 can be active at once.</Text>

      <AnnouncementDialog open={creating || editing !== null} editing={editing} onClose={() => { setCreating(false); setEditing(null); }} onSaved={reload} />
      <AlertDialog open={deleting !== null} tone="warning" onCancel={() => setDeleting(null)} onConfirm={confirmDelete} title="Delete this announcement?" confirmLabel="Delete">
        {deleting ? `“${deleting.message}” stops being sent, and who has received it is forgotten.` : ''}
      </AlertDialog>
    </Page>
  );
}
