import { describe, expect, test } from 'bun:test';
import type { FieldIssue } from '@clawrouter/shared';
import { checkExpiry, nextMidnight, resolveExpiry } from '../src/expiry.ts';

const at = (iso: string) => new Date(iso);

describe('key expiry', () => {
  test('end of today is the next midnight in the user\'s time zone', () => {
    expect(nextMidnight(at('2026-11-13T15:30:00Z'), 'Europe/London').toISOString()).toBe('2026-11-14T00:00:00.000Z');
    expect(nextMidnight(at('2026-11-13T23:30:00Z'), 'America/New_York').toISOString()).toBe('2026-11-14T05:00:00.000Z');
    // Already tomorrow in Tokyo.
    expect(nextMidnight(at('2026-11-13T23:30:00Z'), 'Asia/Tokyo').toISOString()).toBe('2026-11-14T15:00:00.000Z');
    expect(nextMidnight(at('2026-11-13T10:00:00Z'), 'Asia/Kolkata').toISOString()).toBe('2026-11-13T18:30:00.000Z');
  });

  test('daylight-saving changes are handled', () => {
    // London springs forward on 29 March 2026: the next midnight is in BST.
    expect(nextMidnight(at('2026-03-29T00:30:00Z'), 'Europe/London').toISOString()).toBe('2026-03-29T23:00:00.000Z');
    // New York falls back on 1 November 2026: the evening before is still EDT.
    expect(nextMidnight(at('2026-11-01T03:00:00Z'), 'America/New_York').toISOString()).toBe('2026-11-01T04:00:00.000Z');
  });

  test('resolution of each kind', () => {
    const now = at('2026-11-13T12:00:00Z');
    const issues: FieldIssue[] = [];
    expect(resolveExpiry({ type: 'never' }, now, 'expiry', issues)).toBeNull();
    expect(resolveExpiry({ type: 'after', hours: 24 }, now, 'expiry', issues)).toBe('2026-11-14T12:00:00.000Z');
    expect(resolveExpiry({ type: 'end_of_day', timeZone: 'UTC' }, now, 'expiry', issues)).toBe('2026-11-14T00:00:00.000Z');
    expect(resolveExpiry({ type: 'at', at: '2026-12-01T09:00:00Z' }, now, 'expiry', issues)).toBe('2026-12-01T09:00:00.000Z');
    expect(issues).toEqual([]);
    resolveExpiry({ type: 'at', at: '2026-11-01T00:00:00Z' }, now, 'expiry', issues);
    expect(issues).toEqual([{ path: 'expiry', message: 'must be in the future' }]);
  });

  test('validation refuses anything else', () => {
    for (const bad of [null, 'never', [], { type: 'soon' }, { type: 'after', hours: 0 }, { type: 'after', hours: 1.5 }, { type: 'after', hours: 24 * 3651 },
      { type: 'end_of_day', timeZone: 'Mars/Olympus' }, { type: 'end_of_day' }, { type: 'at', at: 'tomorrow' }, { type: 'never', extra: 1 }]) {
      const issues: FieldIssue[] = [];
      expect(checkExpiry(bad, 'expiry', issues)).toBeUndefined();
      expect(issues.length).toBeGreaterThan(0);
    }
    expect(checkExpiry({ type: 'end_of_day', timeZone: 'Pacific/Auckland' }, 'expiry', [])).toEqual({ type: 'end_of_day', timeZone: 'Pacific/Auckland' });
  });
});
