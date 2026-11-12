import { describe, expect, test } from 'bun:test';
import { createEventBus } from '@clawapi/core';
import type { HealthState } from '@clawapi/shared';
import { aggregateHealth, createDatabaseCheck, createHealthService, createPlatformCheck, type HealthCheck } from '../src/index.ts';

const check = (status: HealthState, critical = false): HealthCheck => ({ component: 'platform', critical, check: () => ({ status }) });

describe('aggregateHealth', () => {
  const r = (status: HealthState, critical = false) => ({ status, critical });
  test.each([
    [[r('HEALTHY'), r('HEALTHY', true)], 'HEALTHY'],
    [[r('HEALTHY'), r('OFFLINE', true)], 'OFFLINE'],
    [[r('OFFLINE'), r('HEALTHY', true)], 'DEGRADED'],
    [[r('DEGRADED'), r('HEALTHY')], 'DEGRADED'],
    [[r('HEALTHY'), r('DISABLED')], 'HEALTHY'],
    [[r('DISABLED')], 'UNKNOWN'],
    [[], 'UNKNOWN'],
    [[r('UNKNOWN'), r('HEALTHY')], 'DEGRADED'],
  ] as const)('%p -> %s', (results, expected) => {
    expect(aggregateHealth([...results])).toBe(expected);
  });
});

describe('health service', () => {
  test('reports checks, version and uptime', async () => {
    let t = new Date('2026-01-01T00:00:00Z');
    const service = createHealthService({ checks: [check('HEALTHY')], version: '1.2.3', environment: 'test', now: () => t });
    t = new Date('2026-01-01T00:01:05Z');
    const report = await service.report();
    expect(report.status).toBe('HEALTHY');
    expect(report.version).toBe('1.2.3');
    expect(report.uptimeSeconds).toBe(65);
    expect(report.checks).toHaveLength(1);
  });

  test('a throwing check is OFFLINE, not a crash', async () => {
    const failing: HealthCheck = { component: 'database', critical: true, check: () => { throw new Error('x'); } };
    const report = await createHealthService({ checks: [failing], version: '0', environment: 'test' }).report();
    expect(report.status).toBe('OFFLINE');
    expect(report.checks[0]!.detail).toBe('Check failed');
  });

  test('a hanging check times out', async () => {
    const slow: HealthCheck = { component: 'database', critical: false, check: () => new Promise(() => {}) };
    const report = await createHealthService({ checks: [slow], version: '0', environment: 'test', timeoutMs: 20 }).report();
    expect(report.checks[0]!.status).toBe('OFFLINE');
    expect(report.checks[0]!.detail).toContain('timed out');
    expect(report.status).toBe('DEGRADED');
  });

  test('emits health.changed only when the overall status changes', async () => {
    let status: HealthState = 'HEALTHY';
    const events = createEventBus();
    const changes: string[] = [];
    events.on('health.changed', (e) => { changes.push(`${e.previous}->${e.current}`); });
    const service = createHealthService({ checks: [{ component: 'database', critical: true, check: () => ({ status }) }], version: '0', environment: 'test', events });
    await service.report();
    await service.report();
    status = 'OFFLINE';
    await service.report();
    expect(changes).toEqual(['UNKNOWN->HEALTHY', 'HEALTHY->OFFLINE']);
    expect(service.lastStatus).toBe('OFFLINE');
  });
});

describe('built-in checks', () => {
  test('database check', async () => {
    expect((await createDatabaseCheck({ ping() {} }).check()).status).toBe('HEALTHY');
    expect((await createDatabaseCheck({ ping() { throw new Error('closed'); } }).check()).status).toBe('OFFLINE');
  });

  test('platform check degrades on high heap usage', async () => {
    const high = createPlatformCheck({ heapWarningBytes: 10, memoryUsage: () => ({ heapUsed: 11, rss: 20 }) });
    expect((await high.check()).status).toBe('DEGRADED');
  });
});
