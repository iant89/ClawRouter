/**
 * Calendar periods for "once a day" and "once a week" announcements, in the
 * announcement's time zone: two instants are in the same period when these
 * keys are equal. Weeks start on Monday.
 */
function localDate(t: Date, timeZone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(t);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

export function dayKey(t: Date, timeZone: string): string {
  const { y, m, d } = localDate(t, timeZone);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function weekKey(t: Date, timeZone: string): string {
  const { y, m, d } = localDate(t, timeZone);
  // Work on the local calendar date as if it were UTC: only the date matters here.
  const date = new Date(Date.UTC(y, m - 1, d));
  const fromMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - fromMonday);
  return `week-of-${date.toISOString().slice(0, 10)}`;
}

export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
