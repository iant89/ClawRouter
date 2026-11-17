import { NumberInput, ProgressBar, Select, Switch, Text, TimeZonePicker, WithFieldHelp } from '@enterprise-ui/react';
import { DEFAULT_QUOTA, QUOTA_AMOUNT_MAX, type QuotaPeriod, type QuotaUnit, type QuotaUsage, type UserQuota } from '@clawrouter/shared';

const UNIT_OPTIONS: { value: QuotaUnit; label: string; description: string }[] = [
  { value: 'tokens', label: 'Tokens', description: 'Input and output tokens' },
  { value: 'requests', label: 'Requests', description: 'Completed requests' },
  { value: 'cost', label: 'Cost (US$)', description: 'Estimated from model prices' },
];
const PERIOD_OPTIONS: { value: QuotaPeriod; label: string }[] = [
  { value: 'day', label: 'Every day' },
  { value: 'week', label: 'Every week' },
  { value: 'month', label: 'Every month' },
];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }));

const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))', gap: 'var(--eui-space-3, 0.75rem)', alignItems: 'start' } as const;

/** The browser's time zone, the default for a new quota. */
export const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export const newQuota = (): UserQuota => ({ ...DEFAULT_QUOTA, timeZone: browserTimeZone() });

/** "1,000,000 tokens", "500 requests", "$25.00". */
export function formatQuota(unit: QuotaUnit, n: number): string {
  if (unit === 'cost') return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${Math.round(n).toLocaleString()} ${unit === 'tokens' ? 'tokens' : 'requests'}`;
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

/** "Resets every Monday at 09:00 (Europe/London)". */
export function describeReset(q: UserQuota): string {
  const at = `${String(q.resetHour).padStart(2, '0')}:00`;
  const when = q.period === 'day' ? 'every day' : q.period === 'week' ? `every ${WEEKDAYS[q.resetWeekday - 1]}` : `on the ${ordinal(q.resetDayOfMonth)} of every month`;
  return `Resets ${when} at ${at} (${q.timeZone})`;
}

/** "1,000,000 tokens per month" */
export const describeQuota = (q: UserQuota) => `${formatQuota(q.unit, q.amount)} per ${q.period}`;

export type QuotaErrors = Partial<Record<keyof UserQuota, string>>;

/** Issues from the server for a quota, by field (`quota.amount` → `amount`). */
export function quotaErrors(issues: { path: string; message: string }[]): QuotaErrors {
  const out: QuotaErrors = {};
  for (const i of issues) {
    const m = /^quota\.(\w+)$/.exec(i.path);
    if (m) out[m[1] as keyof UserQuota] = `This ${i.message}.`;
  }
  return out;
}

/**
 * A user's usage quota: off, or how much (tokens, requests or cost) per day,
 * week or month, and when it resets. Used when creating and when editing a user.
 */
export function QuotaFields({ value, onChange, errors = {}, disabled }: {
  value: UserQuota | null;
  onChange: (next: UserQuota | null) => void;
  errors?: QuotaErrors;
  disabled?: boolean;
}) {
  const set = (patch: Partial<UserQuota>) => value && onChange({ ...value, ...patch });
  return (
    <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
      <WithFieldHelp label="Limit this user's usage" help="A quota is a budget for all of the user's API keys together. Once it is used up, their keys are refused (429) until it resets. Rate limits still apply on top.">
        <Switch label="Limit this user's usage (quota)" checked={value !== null} disabled={disabled}
          onChange={(on) => onChange(on ? (value ?? newQuota()) : null)} />
      </WithFieldHelp>
      {value && (
        <>
          <WithFieldHelp label="Enforce this quota" help="Off keeps the quota and its usage, but the user's keys are not refused when it is used up. Turn it on again at any time.">
            <Switch label="Enforce this quota" checked={value.enabled} disabled={disabled} onChange={(on) => set({ enabled: on })} />
          </WithFieldHelp>
          <div style={grid}>
            <Select label="Measured in" value={value.unit} options={UNIT_OPTIONS} disabled={disabled} error={errors.unit}
              onChange={(v) => v && set({ unit: v as QuotaUnit, amount: v === value.unit ? value.amount : v === 'cost' ? 10 : v === 'requests' ? 1000 : 1_000_000 })} />
            <WithFieldHelp label="Allowed" help={value.unit === 'cost' ? 'Estimated from the prices set on each model. Requests to models without a price cost nothing here.' : value.unit === 'requests' ? 'Completed requests. Failed and refused requests do not count.' : 'Input and output tokens, as the provider reports them (or estimated).'}>
              <NumberInput label="Allowed" min={value.unit === 'cost' ? 0.01 : 1} max={QUOTA_AMOUNT_MAX} step={value.unit === 'cost' ? 1 : value.unit === 'requests' ? 100 : 10_000}
                precision={value.unit === 'cost' ? 2 : 0} unit={value.unit === 'cost' ? 'US$' : undefined} value={value.amount} disabled={disabled} error={errors.amount}
                onChange={(n) => set({ amount: n ?? 1 })} />
            </WithFieldHelp>
            <Select label="Resets" value={value.period} options={PERIOD_OPTIONS} disabled={disabled} error={errors.period}
              onChange={(v) => v && set({ period: v as QuotaPeriod })} />
          </div>
          <div style={grid}>
            {value.period === 'week' && (
              <Select label="On" value={String(value.resetWeekday)} options={WEEKDAYS.map((d, i) => ({ value: String(i + 1), label: d }))} disabled={disabled} error={errors.resetWeekday}
                onChange={(v) => v && set({ resetWeekday: Number(v) })} />
            )}
            {value.period === 'month' && (
              <WithFieldHelp label="On day" help="Days 29 to 31 are not offered, so the quota resets in every month, February included.">
                <NumberInput label="On day" description="1–28" min={1} max={28} step={1} value={value.resetDayOfMonth} disabled={disabled} error={errors.resetDayOfMonth}
                  onChange={(n) => set({ resetDayOfMonth: n ?? 1 })} />
              </WithFieldHelp>
            )}
            <Select label="At" value={String(value.resetHour)} options={HOUR_OPTIONS} disabled={disabled} error={errors.resetHour}
              onChange={(v) => v && set({ resetHour: Number(v) })} />
            <WithFieldHelp label="Time zone" help="The reset time is in this time zone, so a daily quota resets at the user's own midnight, not the server's.">
              <TimeZonePicker label="Time zone" value={value.timeZone} disabled={disabled} error={errors.timeZone}
                onChange={(tz) => tz && set({ timeZone: tz })} />
            </WithFieldHelp>
          </div>
          <Text size="sm" tone="secondary">{describeQuota(value)}. {describeReset(value)}.{value.enabled ? '' : ' Turned off: not enforced.'}</Text>
        </>
      )}
    </div>
  );
}

/** Where a user stands: "12,345 of 1,000,000 tokens · resets in 3 days". */
export function QuotaUsageBar({ quota, usage, enforced = true }: { quota: UserQuota; usage: QuotaUsage; enforced?: boolean }) {
  const ratio = usage.limit > 0 ? usage.used / usage.limit : 0;
  // Not enforced: no red or amber, since nothing will be refused.
  const tone = !enforced ? 'information' : ratio >= 1 ? 'error' : ratio >= 0.8 ? 'warning' : 'success';
  const resets = new Date(usage.resetsAt);
  return (
    <div style={{ display: 'grid', gap: 'var(--eui-space-1, 0.25rem)' }}>
      <ProgressBar value={Math.min(usage.used, usage.limit)} max={usage.limit} tone={tone}
        label={!enforced ? 'Used this period (not enforced)' : ratio >= 1 ? 'Quota used up' : 'Used this period'}
        showValue formatValue={() => `${formatQuota(quota.unit, usage.used)} of ${formatQuota(quota.unit, usage.limit)}`} />
      <Text size="sm" tone="secondary">
        {enforced && ratio >= 1 ? 'API keys are refused until ' : 'Resets '}
        {resets.toLocaleString(undefined, { timeZone: quota.timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} ({quota.timeZone})
      </Text>
    </div>
  );
}
