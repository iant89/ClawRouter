import { describe, expect, test } from 'bun:test';
import { NAV_ITEMS, NAVIGATION, resolvePath, visibleNavigation } from '../src/app/navigation.ts';
import { describeUserAgent, formatRelative, formatUptime } from '../src/services/format.ts';

describe('console navigation', () => {
  test('matches the spec §17 structure', () => {
    expect(NAVIGATION.map((g) => g.label)).toEqual([null, 'Gateway', 'AI Infrastructure', 'System', 'Administration']);
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      'Dashboard', 'Requests', 'API Access', 'Usage', 'Providers', 'Models', 'Routing',
      'Health', 'Logs', 'Audit', 'Users', 'Roles', 'Sessions', 'Settings',
    ]);
  });

  test('ids and paths are unique', () => {
    expect(new Set(NAV_ITEMS.map((i) => i.id)).size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((i) => i.path)).size).toBe(NAV_ITEMS.length);
  });

  test('console paths never collide with API namespaces', () => {
    for (const item of NAV_ITEMS) expect(item.path).not.toMatch(/^\/(api|v1)(\/|$)/);
  });

  test('resolves paths, ignoring trailing slashes', () => {
    expect(resolvePath('/')?.id).toBe('dashboard');
    expect(resolvePath('/providers/')?.id).toBe('providers');
    expect(resolvePath('/nope')).toBeUndefined();
  });

  test('only implemented pages lack a planned phase', () => {
    expect(NAV_ITEMS.filter((i) => i.plannedPhase === undefined).map((i) => i.id)).toEqual(['dashboard', 'providers', 'health', 'users', 'roles', 'sessions']);
  });
});

describe('formatUptime', () => {
  test.each([[5, '5s'], [65, '1m 5s'], [3_700, '1h 1m'], [90_000, '1d 1h']])('%d -> %s', (s, out) => {
    expect(formatUptime(s)).toBe(out);
  });
});

describe('describeUserAgent', () => {
  test.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'Safari on macOS'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0', 'Edge on Windows'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0', 'Firefox on Linux'],
    ['Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36', 'Chrome on Android'],
    ['curl/8.5.0', 'curl'],
    [null, 'Unknown device'],
  ])('%p -> %s', (ua, out) => {
    expect(describeUserAgent(ua)).toBe(out);
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  test.each([
    ['2026-01-01T11:59:40Z', 'just now'],
    ['2026-01-01T11:55:00Z', '5 min ago'],
    ['2026-01-01T09:00:00Z', '3 h ago'],
    ['2025-12-30T12:00:00Z', '2 d ago'],
  ])('%s -> %s', (iso, out) => {
    expect(formatRelative(iso, now)).toBe(out);
  });
});

describe('visibleNavigation', () => {
  test('a user without roles sees only the dashboard', () => {
    expect(visibleNavigation(new Set()).flatMap((g) => g.items.map((i) => i.id))).toEqual(['dashboard']);
  });

  test('a viewer sees read-only gateway areas and no administration', () => {
    const viewer = new Set(['providers.read', 'models.read', 'routing.read', 'requests.read', 'usage.read', 'health.read']);
    const groups = visibleNavigation(viewer);
    expect(groups.map((g) => g.label)).toEqual([null, 'Gateway', 'AI Infrastructure', 'System']);
    expect(groups.flatMap((g) => g.items.map((i) => i.id))).not.toContain('logs');
  });

  test('every page except the dashboard requires a permission', () => {
    expect(NAV_ITEMS.filter((i) => !i.permission).map((i) => i.id)).toEqual(['dashboard']);
  });
});
