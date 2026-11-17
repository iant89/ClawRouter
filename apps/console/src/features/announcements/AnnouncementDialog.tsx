import { useEffect, useState } from 'react';
import { Button, ComboBox, DateTimePicker, Dialog, MessageStrip, RadioGroup, Select, Switch, TextArea, useToast } from '@enterprise-ui/react';
import {
  ANNOUNCEMENT_CHANNEL_LABELS, ANNOUNCEMENT_CHANNELS, ANNOUNCEMENT_FREQUENCIES, ANNOUNCEMENT_FREQUENCY_LABELS, NOTICE_TEXT_MAX,
  type AnnouncementChannel, type AnnouncementFrequency, type AnnouncementInfo,
} from '@clawrouter/shared';
import { WithFieldHelp } from '../../components/custom/FieldHelp.tsx';
import { ApiClientError } from '../../services/api-client.ts';
import { createAnnouncement, updateAnnouncement } from '../../services/notices.ts';

/** `2026-11-17T09:30` in the browser's time zone ↔ ISO. */
const toLocal = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const toIso = (local: string) => (local ? new Date(local).toISOString() : null);
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const FREQUENCY_HELP: Record<AnnouncementFrequency, string> = {
  every_request: 'On every response, for as long as it is active. Best for short, urgent messages.',
  once: 'The first time each user makes a request; never again for them, on any of their keys.',
  daily: 'On each user’s first request of the day (in the time zone below).',
  weekly: 'On each user’s first request of the week, weeks starting on Monday (in the time zone below).',
};

/**
 * Create or edit an announcement. "User" is the API key's owner: all of a user's
 * keys share one schedule, so "once" means once per person, not once per key.
 */
export function AnnouncementDialog({ open, editing, onClose, onSaved }: {
  open: boolean;
  editing: AnnouncementInfo | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [message, setMessage] = useState('');
  const [frequency, setFrequency] = useState<AnnouncementFrequency>('once');
  const [channel, setChannel] = useState<AnnouncementChannel>('both');
  const [startsAt, setStartsAt] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [timeZone, setTimeZone] = useState(browserZone());
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setIssues({});
    setError(null);
    setMessage(editing?.message ?? '');
    setFrequency(editing?.frequency ?? 'once');
    setChannel(editing?.channel ?? 'both');
    setStartsAt(toLocal(editing?.startsAt ?? null));
    setExpiresAt(toLocal(editing?.expiresAt ?? null));
    setEnabled(editing?.enabled ?? true);
    setTimeZone(editing?.timeZone ?? browserZone());
  }, [open, editing]);

  const save = async () => {
    setSaving(true);
    setIssues({});
    setError(null);
    const body = { message, frequency, channel, startsAt: toIso(startsAt), expiresAt: toIso(expiresAt), timeZone, enabled };
    try {
      if (editing) await updateAnnouncement(editing.id, body);
      else await createAnnouncement(body);
      toast.show({ tone: 'success', title: editing ? 'Announcement saved' : 'Announcement created', description: enabled ? 'Clients receive it with their next request.' : 'It is turned off until you turn it on.' });
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiClientError && err.issues.length) setIssues(Object.fromEntries(err.issues.map((i) => [i.path, i.message])));
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open} onClose={onClose} size="md" title={editing ? 'Edit announcement' : 'New announcement'}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void save()} loading={saving}>{editing ? 'Save' : 'Create'}</Button>
      </>}
    >
      {error && <MessageStrip tone="error">{error}</MessageStrip>}
      <TextArea label="Message" rows={3} required value={message} maxLength={NOTICE_TEXT_MAX} showCount error={issues.message}
        description="One line; line breaks become spaces. Shown as “📢 ClawRouter: …”." onChange={(e) => setMessage(e.target.value)} />
      <WithFieldHelp label="How often" help={FREQUENCY_HELP[frequency]}>
        <Select label="How often" value={frequency} onChange={(v) => v && setFrequency(v as AnnouncementFrequency)}
          options={ANNOUNCEMENT_FREQUENCIES.map((f) => ({ value: f, label: ANNOUNCEMENT_FREQUENCY_LABELS[f] }))} error={issues.frequency} />
      </WithFieldHelp>
      <WithFieldHelp label="Where" help="The header is read by apps built for it and is invisible otherwise. Reply text is seen by people in chat apps; it is never added to replies that use tools, or for keys that turned notices off. Both settings under Settings → Client notices must allow the channel.">
        <RadioGroup label="Where" value={channel} onChange={(v) => setChannel(v as AnnouncementChannel)}
          options={ANNOUNCEMENT_CHANNELS.map((c) => ({ value: c, label: ANNOUNCEMENT_CHANNEL_LABELS[c] }))} />
      </WithFieldHelp>
      <div className="claw-settings-grid">
        <DateTimePicker label="Starts" description="Empty: at once." value={startsAt} onChange={setStartsAt} error={issues.startsAt} />
        <DateTimePicker label="Expires" description="Empty: until deleted. Deleted automatically then." value={expiresAt} onChange={setExpiresAt} error={issues.expiresAt} />
      </div>
      {(frequency === 'daily' || frequency === 'weekly') && (
        <WithFieldHelp label="Time zone" help="Where a new day (or a new week, on Monday) begins for this announcement. Defaults to your browser's time zone.">
          <ComboBox label="Time zone" value={timeZone} onChange={(v) => v && setTimeZone(v)} error={issues.timeZone}
            options={zoneOptions(timeZone)} />
        </WithFieldHelp>
      )}
      <Switch label="Active" checked={enabled} onChange={setEnabled} description="Turn off to pause it without deleting it." />
    </Dialog>
  );
}

function zoneOptions(current: string) {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const zones = intl.supportedValuesOf?.('timeZone') ?? [];
  const all = zones.includes(current) ? zones : [current, ...zones];
  return (all.includes('UTC') ? all : ['UTC', ...all]).map((z) => ({ value: z, label: z.replace(/_/g, ' ') }));
}
