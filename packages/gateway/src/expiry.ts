import { KEY_EXPIRY_MAX_HOURS, type FieldIssue, type KeyExpiry } from '@clawrouter/shared';

const HOUR = 3_600_000;

const validTimeZone = (tz: unknown): tz is string => {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** Shape and range check (the console's own checks are only feedback). */
export function checkExpiry(value: unknown, path: string, issues: FieldIssue[]): KeyExpiry | undefined {
  const v = value as Record<string, unknown> | null;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    issues.push({ path, message: 'must be an expiry object' });
    return undefined;
  }
  const extra = (allowed: string[]) => Object.keys(v).some((k) => !allowed.includes(k));
  switch (v.type) {
    case 'never':
      if (extra(['type'])) break;
      return { type: 'never' };
    case 'end_of_day':
      if (extra(['type', 'timeZone'])) break;
      if (!validTimeZone(v.timeZone)) {
        issues.push({ path: `${path}.timeZone`, message: 'must be an IANA time zone, e.g. Europe/London' });
        return undefined;
      }
      return { type: 'end_of_day', timeZone: v.timeZone };
    case 'after':
      if (extra(['type', 'hours'])) break;
      if (typeof v.hours !== 'number' || !Number.isInteger(v.hours) || v.hours < 1 || v.hours > KEY_EXPIRY_MAX_HOURS) {
        issues.push({ path: `${path}.hours`, message: `must be a whole number of hours from 1 to ${KEY_EXPIRY_MAX_HOURS}` });
        return undefined;
      }
      return { type: 'after', hours: v.hours };
    case 'at':
      if (extra(['type', 'at'])) break;
      if (typeof v.at !== 'string' || Number.isNaN(Date.parse(v.at))) {
        issues.push({ path: `${path}.at`, message: 'must be an ISO date-time' });
        return undefined;
      }
      return { type: 'at', at: new Date(Date.parse(v.at)).toISOString() };
  }
  issues.push({ path, message: 'must be { type: "never" | "end_of_day" | "after" | "at", ... } with no other fields' });
  return undefined;
}

/** Offset of `timeZone` from UTC at instant `t`, in ms (positive east of Greenwich). */
function zoneOffset(t: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(t).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]),
  );
  const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return wall - (t - (t % 1000));
}

/** The next midnight after `now` in `timeZone` (handles DST changes on that night). */
export function nextMidnight(now: Date, timeZone: string): Date {
  const t = now.getTime();
  const local = new Date(t + zoneOffset(t, timeZone));
  const midnightWall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1);
  // Convert the wall-clock midnight back to an instant; re-check the offset at that instant (DST).
  let guess = midnightWall - zoneOffset(midnightWall, timeZone);
  guess = midnightWall - zoneOffset(guess, timeZone);
  return new Date(guess);
}

/**
 * The expiry instant (ISO) for a key created at `now`, or null for none.
 * Throws a field issue when the result is not in the future.
 */
export function resolveExpiry(expiry: KeyExpiry, now: Date, path: string, issues: FieldIssue[]): string | null {
  let at: number;
  switch (expiry.type) {
    case 'never':
      return null;
    case 'end_of_day':
      at = nextMidnight(now, expiry.timeZone).getTime();
      break;
    case 'after':
      at = now.getTime() + expiry.hours * HOUR;
      break;
    case 'at':
      at = Date.parse(expiry.at);
      break;
  }
  if (at <= now.getTime()) {
    issues.push({ path, message: 'must be in the future' });
    return null;
  }
  return new Date(at).toISOString();
}
