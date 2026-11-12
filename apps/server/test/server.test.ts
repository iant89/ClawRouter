import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { loadConfig, silentLogger } from '@clawapi/core';
import type { ApiSuccess, HealthReport } from '@clawapi/shared';
import { startClawApi, type ClawApi } from '../src/server.ts';

/** End-to-end over a real socket: Bun server + SQLite (in memory) + migrations + API. */
describe('ClawAPI server', () => {
  let app: ClawApi;

  beforeAll(async () => {
    const config = loadConfig({ CLAWAPI_ENV: 'test', CLAWAPI_PORT: '0' });
    app = await startClawApi({ config, log: silentLogger, version: 'test' });
  });
  afterAll(() => app.stop());

  test('serves /api/health', async () => {
    const res = await fetch(new URL('/api/health', app.url));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as ApiSuccess<HealthReport>;
    expect(data.status).toBe('HEALTHY');
    expect(data.checks.map((c) => c.component).sort()).toEqual(['database', 'platform']);
  });

  test('migrations ran on startup', () => {
    expect(app.db.get<{ id: string }>("SELECT id FROM schema_migrations WHERE id = '0001_settings'")?.id).toBe('0001_settings');
  });

  test('runs headless: without a console bundle, non-API paths are 404 JSON', async () => {
    const res = await fetch(new URL('/dashboard', app.url));
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  test('reports OFFLINE with 503 when the database goes away', async () => {
    const config = loadConfig({ CLAWAPI_ENV: 'test', CLAWAPI_PORT: '0' });
    const other = await startClawApi({ config, log: silentLogger, version: 'test' });
    try {
      other.db.close();
      const res = await fetch(new URL('/api/health', other.url));
      expect(res.status).toBe(503);
    } finally {
      await other.server.stop();
    }
  });
});
