import { DateTimePicker, NumberInput, RadioGroup, Select, Text } from '@enterprise-ui/react';
import { KEY_EXPIRY_MAX_HOURS, type KeyExpiry } from '@clawrouter/shared';

/** What the user is editing; turned into a KeyExpiry with `toKeyExpiry`. */
export interface ExpiryDraft {
  type: KeyExpiry['type'];
  amount: number | null;
  unit: 'hours' | 'days';
  /** Local date-time from the picker (YYYY-MM-DDTHH:mm). */
  at: string;
}

export const NEVER: ExpiryDraft = { type: 'never', amount: 30, unit: 'days', at: '' };

/** The browser's IANA time zone, so "end of today" means the user's today. */
export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Feedback only: the server validates and resolves the expiry itself. */
export function toKeyExpiry(d: ExpiryDraft): { expiry?: KeyExpiry; error?: string } {
  switch (d.type) {
    case 'never':
      return { expiry: { type: 'never' } };
    case 'end_of_day':
      return { expiry: { type: 'end_of_day', timeZone: localTimeZone() } };
    case 'after': {
      const hours = d.amount === null ? NaN : d.amount * (d.unit === 'days' ? 24 : 1);
      if (!Number.isInteger(hours) || hours < 1 || hours > KEY_EXPIRY_MAX_HOURS) return { error: 'Enter a whole number of hours or days (up to ten years).' };
      return { expiry: { type: 'after', hours } };
    }
    case 'at': {
      const t = d.at ? new Date(d.at).getTime() : NaN;
      if (Number.isNaN(t)) return { error: 'Choose the date and time the key stops working.' };
      if (t <= Date.now()) return { error: 'The expiry must be in the future.' };
      return { expiry: { type: 'at', at: new Date(t).toISOString() } };
    }
  }
}

/** When a key with this expiry, created now, would stop working (for display). */
export function expiryPreview(expiry: KeyExpiry | undefined, from = new Date()): string {
  if (!expiry || expiry.type === 'never') return 'Never expires.';
  let at: Date;
  if (expiry.type === 'end_of_day') {
    at = new Date(from);
    at.setHours(24, 0, 0, 0);
  } else if (expiry.type === 'after') {
    at = new Date(from.getTime() + expiry.hours * 3_600_000);
  } else {
    at = new Date(expiry.at);
  }
  return `Stops working ${at.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}.`;
}

/** How an expiry reads in lists ("1 day", "End of the day", ...). */
export function describeExpiry(expiry: KeyExpiry): string {
  switch (expiry.type) {
    case 'never': return 'Never expires';
    case 'end_of_day': return `End of the day it is created (${expiry.timeZone})`;
    case 'after': return expiry.hours % 24 === 0 ? `${expiry.hours / 24} day${expiry.hours === 24 ? '' : 's'} after creation` : `${expiry.hours} hour${expiry.hours === 1 ? '' : 's'} after creation`;
    case 'at': return `Until ${new Date(expiry.at).toLocaleString()}`;
  }
}

/** A draft that shows an existing expiry (e.g. the one a request asked for). */
export function draftOf(expiry: KeyExpiry): ExpiryDraft {
  if (expiry.type === 'after') return expiry.hours % 24 === 0 ? { ...NEVER, type: 'after', amount: expiry.hours / 24, unit: 'days' } : { ...NEVER, type: 'after', amount: expiry.hours, unit: 'hours' };
  if (expiry.type === 'at') {
    const d = new Date(expiry.at);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    return { ...NEVER, type: 'at', at: local };
  }
  return { ...NEVER, type: expiry.type };
}

/**
 * Expiry choice for API keys (owner's request): never, end of today, after a
 * length of time, or on a date. Shows when the key would stop working.
 */
export function ExpiryField({ value, onChange, error, label = 'Expires' }: { value: ExpiryDraft; onChange: (d: ExpiryDraft) => void; error?: string; label?: string }) {
  const { expiry, error: invalid } = toKeyExpiry(value);
  return (
    <div style={{ display: 'grid', gap: 'var(--eui-space-2, 0.5rem)' }}>
      <RadioGroup<KeyExpiry['type']>
        label={label}
        value={value.type}
        onChange={(type) => onChange({ ...value, type })}
        options={[
          { value: 'never', label: 'Never' },
          { value: 'end_of_day', label: 'End of today', description: `At midnight, ${localTimeZone()} time: a key for today only.` },
          { value: 'after', label: 'After a length of time' },
          { value: 'at', label: 'On a date' },
        ]}
      />
      {value.type === 'after' && (
        <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', alignItems: 'end', flexWrap: 'wrap' }}>
          <NumberInput label="Length" value={value.amount} min={1} step={1} onChange={(amount) => onChange({ ...value, amount })} style={{ maxWidth: '8rem' }} />
          <Select<'hours' | 'days'> label="Unit" value={value.unit} onChange={(unit) => unit && onChange({ ...value, unit })} options={[{ value: 'hours', label: 'Hours' }, { value: 'days', label: 'Days' }]} />
        </div>
      )}
      {value.type === 'at' && <DateTimePicker label="Stops working at" value={value.at} onChange={(at) => onChange({ ...value, at })} />}
      <Text size="sm" tone={error || invalid ? 'error' : 'secondary'} role="status">{error ?? invalid ?? expiryPreview(expiry)}</Text>
    </div>
  );
}
