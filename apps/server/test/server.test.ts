import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, silentLogger } from '@clawrouter/core';
import { CSRF_HEADER, type ApiSuccess, type HealthReport } from '@clawrouter/shared';
import { startClawRouter, type ClawRouter } from '../src/server.ts';
import { ADMIN, fastHasher } from '../../../tests/support/harness.ts';

/** End-to-end over a real socket: Bun server + SQLite file + migrations + API. */
describe('ClawRouter server', () => {
  let app: ClawRouter;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'clawrouter-server-'));
    const config = loadConfig({ CLAWROUTER_ENV: 'test', CLAWROUTER_PORT: '0', CLAWROUTER_DATABASE_PATH: join(dir, 'clawrouter.db') });
    app = await startClawRouter({ config, log: silentLogger, version: 'test', hasher: fastHasher });
  });
  afterAll(async () => {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test('serves /api/health without authentication', async () => {
    const res = await fetch(new URL('/api/health', app.url));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as ApiSuccess<HealthReport>;
    expect(data.status).toBe('HEALTHY');
  });

  test('migrations ran on startup', () => {
    const ids = app.db.all<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id').map((r) => r.id);
    expect(ids).toEqual(['0001_settings', '0002_users_sessions', '0003_audit_log', '0004_roles', '0005_notifications', '0006_providers', '0007_models', '0008_routing', '0009_api_keys', '0010_rate_limits', '0011_requests', '0012_health_operations']);
  });

  test('admin API requires a session', async () => {
    expect((await fetch(new URL('/api/auth/session', app.url))).status).toBe(401);
  });

  test('setup token is written to a private file, then setup -> session -> logout works and the file is removed', async () => {
    const file = join(dir, 'setup-token');
    expect(app.setupToken?.file).toBe(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const token = readFileSync(file, 'utf8').trim();

    const setup = await fetch(new URL('/api/setup', app.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: app.url.origin },
      body: JSON.stringify({ setupToken: token, ...ADMIN }),
    });
    expect(setup.status).toBe(201);
    expect(existsSync(file)).toBe(false);
    const cookie = setup.headers.getSetCookie()[0]!.split(';')[0]!;

    expect((await fetch(new URL('/api/auth/session', app.url), { headers: { cookie } })).status).toBe(200);
    const logout = await fetch(new URL('/api/auth/logout', app.url), { method: 'POST', headers: { cookie, [CSRF_HEADER]: '1' } });
    expect(logout.status).toBe(204);
    expect((await fetch(new URL('/api/auth/session', app.url), { headers: { cookie } })).status).toBe(401);
  });

  test('runs headless: without a console bundle, non-API paths are 404 JSON', async () => {
    const res = await fetch(new URL('/dashboard', app.url));
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  test('reports OFFLINE with 503 when the database goes away', async () => {
    const config = loadConfig({ CLAWROUTER_ENV: 'test', CLAWROUTER_PORT: '0', CLAWROUTER_SETUP_TOKEN: 'x'.repeat(20) });
    const other = await startClawRouter({ config, log: silentLogger, version: 'test', hasher: fastHasher });
    try {
      other.db.close();
      expect((await fetch(new URL('/api/health', other.url))).status).toBe(503);
    } finally {
      await other.server.stop();
    }
  });
});
