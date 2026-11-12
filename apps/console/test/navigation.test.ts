import { describe, expect, test } from 'bun:test';
import { NAV_ITEMS, NAVIGATION, resolvePath } from '../src/app/navigation.ts';
import { formatUptime } from '../src/services/format.ts';

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
    expect(NAV_ITEMS.filter((i) => i.plannedPhase === undefined).map((i) => i.id)).toEqual(['dashboard', 'health']);
  });
});

describe('formatUptime', () => {
  test.each([[5, '5s'], [65, '1m 5s'], [3_700, '1h 1m'], [90_000, '1d 1h']])('%d -> %s', (s, out) => {
    expect(formatUptime(s)).toBe(out);
  });
});
