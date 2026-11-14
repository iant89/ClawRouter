import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, silentLogger } from '@clawrouter/core';
import { startClawRouter, type ClawRouter } from '../src/server.ts';
import { fastHasher } from '../../../tests/support/harness.ts';
import { startMockProviders, type MockProviders } from '../../../tests/support/mock-providers.ts';

/** Phase 17: SIGTERM drains instead of dropping requests. Over a real socket. */
describe('graceful shutdown', () => {
  let mock: MockProviders;
  let dir: string;
  beforeAll(() => {
    mock = startMockProviders();
    dir = mkdtempSync(join(tmpdir(), 'clawrouter-shutdown-'));
  });
  afterAll(async () => {
    await mock.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(name: string): Promise<{ app: ClawRouter; chat: () => Promise<Response> }> {
    const config = loadConfig({ CLAWROUTER_ENV: 'test', CLAWROUTER_PORT: '0', CLAWROUTER_DATABASE_PATH: join(dir, `${name}.db`), CLAWROUTER_SETUP_TOKEN: 'x'.repeat(20) });
    const app = await startClawRouter({ config, log: silentLogger, version: 'test', hasher: fastHasher, providerFetch: fetch });
    const actor = { id: 'ops', username: 'ops' };
    const at = new Date().toISOString();
    app.db.run("INSERT INTO users (id, username, display_name, password_hash, status, created_at, updated_at, password_changed_at) VALUES ('ops', 'ops', 'Ops', 'x', 'ACTIVE', ?, ?, ?)", [at, at, at]);
    const provider = await app.providers.create(actor, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: `${mock.url}/openai/v1`, apiKey: mock.key }, { ip: null });
    app.models.create(actor, { providerId: provider.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT'] }, { ip: null });
    const { secret } = app.apiKeys.create(actor, { name: 'k', expiry: { type: 'after', hours: 24 } }, { ip: null });
    const chat = () => fetch(new URL('/v1/chat/completions', app.url), {
      method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
    });
    return { app, chat };
  }

  test('a request in flight finishes; readiness says draining meanwhile', async () => {
    const { app, chat } = await start('drain');
    expect((await fetch(new URL('/api/health/ready', app.url))).status).toBe(200);
    expect((await fetch(new URL('/api/health/live', app.url))).status).toBe(200);
    mock.mode = 'slow';
    mock.slowMs = 700;
    const pending = chat();
    await Bun.sleep(150); // the request reaches the provider
    const t = performance.now();
    const stopping = app.stop({ graceMs: 5_000 });
    await Bun.sleep(50);
    // Probing the handler directly: the listener no longer accepts connections.
    expect((await app.api.handle(new Request('http://x/api/health/ready'), null)).status).toBe(503);
    // A new gateway request arriving on an open connection is refused, so the client retries elsewhere.
    const refused = await app.server.fetch(new Request(new URL('/v1/models', app.url)));
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('5');
    const res = await pending;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { choices: unknown[] }).choices).toHaveLength(1);
    await stopping;
    expect(performance.now() - t).toBeLessThan(3_000); // it did not wait the whole grace period
  });

  test('past the grace period, requests still running are cut off', async () => {
    const { app, chat } = await start('cut');
    mock.mode = 'slow';
    mock.slowMs = 3_000;
    const pending = chat().then((r) => r.status, () => 'connection closed');
    await Bun.sleep(150);
    const t = performance.now();
    await app.stop({ graceMs: 300 });
    expect(performance.now() - t).toBeLessThan(2_000);
    expect(await pending).not.toBe(200);
    mock.mode = 'ok';
  });
});
