import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createGatewayCheck, createWebSocketCheck } from '@clawrouter/health';
import type { ApiSuccess, ConnectionTestResult, HealthHistoryReport, HealthReport, OperationInfo } from '@clawrouter/shared';
import { createHarness } from '../../../tests/support/harness.ts';
import { startMockProviders, type MockProviders } from '../../../tests/support/mock-providers.ts';

let mock: MockProviders;
beforeAll(() => {
  mock = startMockProviders();
});
afterAll(() => mock.stop());

const data = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;
const actor = { id: 'u', username: 'admin' };

describe('health checks (spec §24)', () => {
  test('gateway: disabled without models, degraded when most recent requests fail or nothing is usable', () => {
    const check = (metrics: { requestsLastMinute: number; errorsLastMinute: number }, models: { registered: number; usable: number }) =>
      createGatewayCheck({ metrics: () => metrics, models: () => models }).check();
    expect(check({ requestsLastMinute: 0, errorsLastMinute: 0 }, { registered: 0, usable: 0 })).toMatchObject({ status: 'DISABLED' });
    expect(check({ requestsLastMinute: 3, errorsLastMinute: 3 }, { registered: 2, usable: 2 })).toMatchObject({ status: 'HEALTHY' }); // too few to judge
    expect(check({ requestsLastMinute: 20, errorsLastMinute: 10 }, { registered: 2, usable: 2 })).toMatchObject({ status: 'DEGRADED', detail: expect.stringContaining('50% failed') });
    expect(check({ requestsLastMinute: 0, errorsLastMinute: 0 }, { registered: 2, usable: 0 })).toMatchObject({ status: 'DEGRADED', detail: expect.stringContaining('0 of 2') });
  });

  test('websocket: connection count, offline when not running', () => {
    expect(createWebSocketCheck({ connections: () => 3 }).check()).toEqual({ status: 'HEALTHY', detail: '3 live connection(s)' });
    expect(createWebSocketCheck({ connections: () => null }).check()).toMatchObject({ status: 'OFFLINE' });
  });

  test('/api/health stays public but shows details and latencies only to users with health.read', async () => {
    const h = createHarness();
    const anonymous = await data<HealthReport>(await h.request('/api/health'));
    expect(anonymous.status).toBe('HEALTHY');
    expect(anonymous.checks.every((c) => c.detail === undefined && c.latencyMs === 0)).toBe(true);
    const admin = await h.completeSetup();
    const full = await data<HealthReport>(await h.request('/api/health', { cookie: admin }));
    expect(full.checks.find((c) => c.component === 'database')?.detail).toBe('SQLite responding');
  });
});

describe('GET /api/health/history', () => {
  test('availability, a 48-bucket timeline and status changes per component', async () => {
    const h = createHarness();
    // Twelve scheduled checks five minutes apart; the database is "down" for three of them.
    for (let i = 0; i < 12; i++) {
      const report = await h.health.report();
      if (i >= 4 && i < 7) report.checks = report.checks.map((c) => (c.component === 'database' ? { ...c, status: 'OFFLINE', detail: 'Database is not responding' } : c));
      h.healthHistory.record(report);
      h.clock.advance(5 * 60_000);
    }
    const admin = await h.completeSetup();
    const r = await data<HealthHistoryReport>(await h.request('/api/health/history?hours=24', { cookie: admin }));
    expect(r.bucketMinutes).toBe(30);
    const db = r.components.find((c) => c.component === 'database')!;
    expect(db).toMatchObject({ current: 'HEALTHY', checks: 12, availability: 0.75 });
    expect(db.buckets).toHaveLength(48);
    expect(db.buckets.filter((b) => b.status === 'OFFLINE').length).toBeGreaterThan(0);
    expect(db.changes.map((c) => `${c.from}->${c.to}`)).toEqual(['OFFLINE->HEALTHY', 'HEALTHY->OFFLINE', 'null->HEALTHY']);
    expect(r.components.find((c) => c.component === 'gateway')).toMatchObject({ current: 'DISABLED', availability: null });

    expect((await h.request('/api/health/history?hours=0', { cookie: admin })).status).toBe(400);
    expect((await h.request('/api/health/history?component=kitchen', { cookie: admin })).status).toBe(400);
    await h.addUser('nobody', []);
    expect((await h.request('/api/health/history', { cookie: await h.login('nobody') })).status).toBe(403);
  });

  test('history older than the retention period is pruned', async () => {
    const h = createHarness();
    h.healthHistory.record(await h.health.report());
    h.clock.advance(8 * 86_400_000);
    expect(h.healthHistory.prune()).toBe(2);
  });
});

describe('/api/operations', () => {
  test('a provider connection test runs as an operation and appears in the list', async () => {
    const h = createHarness();
    h.setProviderFetch(fetch);
    const admin = await h.completeSetup();
    const p = await h.providers.create(actor, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: `${mock.url}/openai/v1`, apiKey: mock.key }, { ip: null });
    const res = await h.request(`/api/providers/${p.id}/test`, { method: 'POST', cookie: admin });
    const result = await data<ConnectionTestResult>(res);
    // Read before asserting: Bun's toMatchObject writes asymmetric matchers into the received object.
    const operationId = result.operationId;
    expect(result).toMatchObject({ ok: true, status: 'HEALTHY', operationId: expect.any(String) });
    const got = await h.request(`/api/operations/${operationId}`, { cookie: admin });
    const op = await data<OperationInfo>(got);
    expect(op).toMatchObject({ type: 'provider.test', targetId: p.id, targetLabel: 'OpenAI', status: 'SUCCESS', createdBy: { username: 'admin' } });
    expect(JSON.stringify(op)).not.toContain(mock.key);
  });

  test('start, list and cancel follow the permissions of each operation type', async () => {
    const h = createHarness();
    h.setProviderFetch(fetch);
    const admin = await h.completeSetup();
    await h.addUser('viewer', ['VIEWER']);
    await h.addUser('nobody', []);
    const viewer = await h.login('viewer');
    const nobody = await h.login('nobody');

    const started = await h.request('/api/operations', { method: 'POST', cookie: viewer, json: { type: 'health.check' } });
    expect(started.status).toBe(201);
    const op = await data<OperationInfo>(started);
    await Bun.sleep(20);
    const done = await data<OperationInfo>(await h.request(`/api/operations/${op.id}`, { cookie: viewer }));
    expect(done).toMatchObject({ status: 'SUCCESS', message: 'Platform healthy', result: { status: 'HEALTHY' } });

    expect((await h.request('/api/operations', { method: 'POST', cookie: viewer, json: { type: 'providers.check' } })).status).toBe(403);
    expect((await h.request('/api/operations', { method: 'POST', cookie: admin, json: { type: 'self.destruct' } })).status).toBe(400);
    expect((await h.request('/api/operations', { method: 'POST', cookie: admin, json: { type: 'provider.test', targetId: 'nope' } })).status).toBe(404);
    expect((await h.request('/api/operations', { cookie: nobody })).status).toBe(200);
    expect(((await (await h.request('/api/operations', { cookie: nobody })).json()) as ApiSuccess<OperationInfo[]>).data).toEqual([]);
    expect((await h.request(`/api/operations/${op.id}`, { cookie: nobody })).status).toBe(404);
    expect((await h.request(`/api/operations/${op.id}/cancel`, { method: 'POST', cookie: admin })).status).toBe(409);
    expect((await h.request('/api/operations')).status).toBe(401);

    const checkAll = await data<OperationInfo>(await h.request('/api/operations', { method: 'POST', cookie: admin, json: { type: 'providers.check' } }));
    await Bun.sleep(20);
    expect(await data<OperationInfo>(await h.request(`/api/operations/${checkAll.id}`, { cookie: admin }))).toMatchObject({ status: 'SUCCESS', message: 'No providers are enabled' });
  });
});
