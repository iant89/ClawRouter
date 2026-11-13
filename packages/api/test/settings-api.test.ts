import { describe, expect, test } from 'bun:test';
import { createAuditService, createSqliteAuditRepository } from '@clawrouter/audit';
import { createSqliteSettingsRepository } from '@clawrouter/database';
import { createSettingsService } from '@clawrouter/settings';
import type { ApiErrorBody, ApiSuccess, SettingInfo } from '@clawrouter/shared';
import { ADMIN, createHarness } from '../../../tests/support/harness.ts';

const data = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;
const put = (cookie: string, values: Record<string, unknown>) => ({ method: 'PUT', cookie, json: { values } });

describe('system settings', () => {
  test('lists every setting with its default; changes are audited and take effect at once', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const list = await data<SettingInfo[]>(await h.request('/api/settings', { cookie: admin }));
    expect(list.map((s) => s.key)).toEqual(['sessionIdleMinutes', 'sessionMaxHours', 'signInMaxFailures', 'requestRetentionDays', 'usageRetentionDays', 'healthHistoryDays']);
    expect(list[0]).toMatchObject({ value: 60, defaultValue: 60, overridden: false, env: 'CLAWROUTER_SESSION_IDLE_MINUTES', unit: 'minutes' });

    const changed: string[] = [];
    h.events.on('settings.changed', (e) => { changed.push(e.key); });
    const res = await h.request('/api/settings', put(admin, { sessionIdleMinutes: 15, requestRetentionDays: 7 }));
    expect(res.status).toBe(200);
    const after = await data<SettingInfo[]>(res);
    expect(after.find((s) => s.key === 'sessionIdleMinutes')).toMatchObject({ value: 15, defaultValue: 60, overridden: true });
    expect(changed.sort()).toEqual(['requestRetentionDays', 'sessionIdleMinutes']);
    expect(h.audit.list({ action: 'SETTINGS_CHANGED' })[0]!.metadata).toEqual({
      changes: { sessionIdleMinutes: { before: 60, after: 15 }, requestRetentionDays: { before: 30, after: 7 } },
    });

    // The new idle timeout applies to existing sessions.
    h.clock.advance(16 * 60_000);
    expect((await h.request('/api/auth/session', { cookie: admin })).status).toBe(401);
  });

  test('null resets to the default; unchanged values are not audited', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    await h.request('/api/settings', put(admin, { healthHistoryDays: 30 }));
    await h.request('/api/settings', put(admin, { healthHistoryDays: 30 }));
    expect(h.audit.list({ action: 'SETTINGS_CHANGED' })).toHaveLength(1);
    const reset = await data<SettingInfo[]>(await h.request('/api/settings', put(admin, { healthHistoryDays: null })));
    expect(reset.find((s) => s.key === 'healthHistoryDays')).toMatchObject({ value: 7, overridden: false, updatedAt: null });
    expect(h.audit.list({ action: 'SETTINGS_CHANGED' })).toHaveLength(2);
  });

  test('validation: unknown keys and out-of-range values change nothing', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    for (const values of [{ nope: 1 }, { sessionIdleMinutes: 0 }, { sessionMaxHours: 1.5 }, { signInMaxFailures: '10' }, { healthHistoryDays: 366 }]) {
      const res = await h.request('/api/settings', put(admin, values));
      expect(res.status).toBe(400);
    }
    const bad = await h.request('/api/settings', put(admin, { sessionIdleMinutes: 30, sessionMaxHours: 0 }));
    expect(((await bad.json()) as ApiErrorBody).error.details).toMatchObject({ issues: [{ path: 'values.sessionMaxHours' }] });
    expect(h.settings.get('sessionIdleMinutes')).toBe(60);
    expect((await h.request('/api/settings', { method: 'PUT', cookie: admin, json: { sessionIdleMinutes: 5 } })).status).toBe(400);
  });

  test('the sign-in throttle follows its setting', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    await h.request('/api/settings', put(admin, { signInMaxFailures: 3 }));
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await h.request('/api/auth/login', { method: 'POST', json: { username: ADMIN.username, password: 'wrong password!' } })).status);
    expect(statuses).toEqual([401, 401, 401, 429]);
  });

  test('stored values survive a restart; invalid stored values are ignored', () => {
    const h = createHarness();
    const repo = createSqliteSettingsRepository(h.db);
    repo.set('system.usage_retention_days', 90);
    repo.set('system.session_max_hours', 99_999);
    const reloaded = createSettingsService({ repo, audit: createAuditService(createSqliteAuditRepository(h.db)), defaults: { sessionIdleMinutes: 60, sessionMaxHours: 12, signInMaxFailures: 10, requestRetentionDays: 30, usageRetentionDays: 400, healthHistoryDays: 7 } });
    expect(reloaded.get('usageRetentionDays')).toBe(90);
    expect(reloaded.get('sessionMaxHours')).toBe(12);
  });

  test('operators and viewers cannot read or change settings', async () => {
    const h = createHarness();
    await h.completeSetup();
    await h.addUser('op', ['OPERATOR']);
    const op = await h.login('op');
    expect((await h.request('/api/settings', { cookie: op })).status).toBe(403);
    expect((await h.request('/api/settings', put(op, { sessionIdleMinutes: 5 }))).status).toBe(403);
  });
});
