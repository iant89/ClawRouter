/*
 * ClawRouter - Self-hosted AI gateway and control platform
 * https://github.com/iant89/ClawRouter
 *
 * Copyright (C) 2026 Ian Thomas
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * in the LICENSE file for more details.
 */

// SEC-025: `bun run doctor --security` passes a safe deployment and names each unsafe
// setting, file mode, stored value and process privilege, as PASS / WARN / FAIL.

import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretBox, generateSecretKey, loadConfig, parseSecretKey, silentLogger, type Config } from '@clawrouter/core';
import { createSqliteSettingsRepository, migrations, openSqlite, runMigrations } from '@clawrouter/database';
import { applyRepairs, plannedRepairs } from '../../../apps/server/src/doctor.ts';
import { readProcessPrivileges, runSecurityChecks, type SecurityCheckOptions } from '../../../apps/server/src/security-check.ts';
import { startClawRouter } from '../../../apps/server/src/server.ts';
import { fastHasher } from '../../support/harness.ts';
import { actor, client } from '../support.ts';

const repo = join(import.meta.dir, '..', '..', '..');
const root = mkdtempSync(join(tmpdir(), 'clawrouter-sec025-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const dir = join(root, `case-${++n}`);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
};

/** A fake /proc with one process: the tests must not depend on who runs them (root in some sandboxes). */
function proc(status: { uid: number; capEff?: string; noNewPrivs?: 0 | 1; seccomp?: 0 | 2 }): string {
  const dir = mkdtempSync(join(root, 'proc-'));
  mkdirSync(join(dir, '4242'));
  writeFileSync(join(dir, '4242', 'status'), [
    'Name:\tbun', `Uid:\t${status.uid}\t${status.uid}\t${status.uid}\t${status.uid}`, `CapEff:\t${status.capEff ?? '0000000000000000'}`,
    `NoNewPrivs:\t${status.noNewPrivs ?? 1}`, `Seccomp:\t${status.seccomp ?? 2}`, '',
  ].join('\n'));
  return dir;
}
const SAFE_PROCESS: SecurityCheckOptions = { pid: 4242, procRoot: proc({ uid: 997 }), container: false, probe: false };

type Checks = Awaited<ReturnType<typeof runSecurityChecks>>;
const levels = (checks: Checks, area: string) => checks.filter((c) => c.area === area).map((c) => c.level);
const find = (checks: Checks, area: string, level: string) => checks.find((c) => c.area === area && c.level === level);

/** A production configuration: secret key file 0600 outside the data directory, behind a local TLS proxy. */
function production(dir: string, env: Record<string, string> = {}): { config: Config; keyFile: string } {
  const keyFile = join(dir, 'secret.key.d', 'secret.key');
  mkdirSync(join(dir, 'secret.key.d'), { mode: 0o700 });
  writeFileSync(keyFile, `${generateSecretKey()}\n`, { mode: 0o600 });
  const config = loadConfig({
    CLAWROUTER_ENV: 'production', CLAWROUTER_DATABASE_PATH: join(dir, 'data', 'clawrouter.db'), CLAWROUTER_SECRET_KEY_FILE: keyFile,
    CLAWROUTER_HOST: '127.0.0.1', CLAWROUTER_PORT: '0', CLAWROUTER_TRUSTED_PROXIES: '127.0.0.1', CLAWROUTER_SETUP_TOKEN: 's'.repeat(24), ...env,
  });
  return { config, keyFile };
}

/** Starts ClawRouter on the configuration, finishes setup and adds an https provider and a key. */
async function deployment(config: Config) {
  const app = await startClawRouter({ config, log: silentLogger, version: 't', hasher: fastHasher });
  const setup = await fetch(new URL('/api/setup', app.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: 's'.repeat(24), username: 'owner', displayName: 'Owner', password: 'lantern orchard 7 quietly' }) });
  expect(setup.status).toBeLessThan(300);
  await app.providers.create(actor, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: 'https://api.example.test/v1', apiKey: 'sk-sec025-0123456789abcdef' }, client);
  const owner = app.db.get<{ id: string }>("SELECT id FROM users WHERE username = 'owner'")!.id;
  await app.apiKeys.create({ id: owner, username: 'owner' }, { name: 'ci' }, client);
  return app;
}

describe('doctor --security (SEC-025)', () => {
  test('a safe production deployment passes, asked over HTTP as well', async () => {
    const dir = fresh();
    const { config, keyFile } = production(dir);
    const app = await deployment(config);
    try {
      const box = createSecretBox(parseSecretKey(await Bun.file(keyFile).text()));
      const checks = await runSecurityChecks(config, box, null, { ...SAFE_PROCESS, probe: true, url: app.url.href });
      const failed = checks.filter((c) => c.level === 'error');
      expect(failed).toEqual([]);
      for (const area of ['environment', 'https', 'cookies', 'trusted proxies', 'secret key', 'database', 'api keys', 'credentials', 'mcp', 'providers', 'request logging', 'csrf', 'cors']) {
        expect([area, levels(checks, area)]).toEqual([area, levels(checks, area).map(() => 'ok')]);
      }
      // The answers come from the running server, not from the configuration.
      expect(find(checks, 'csrf', 'ok')!.message).toContain('refused a cross-site request');
      expect(find(checks, 'cors', 'ok')!.message).toContain('sent no CORS headers');
      expect(find(checks, 'process', 'ok')!.message).toContain('uid 997');
      // One administrator without two-factor: a warning, not a failure.
      expect(find(checks, 'two-factor', 'warn')!.message).toContain('1 of 1 administrator(s)');
      expect(JSON.stringify(checks)).not.toContain('sk-sec025');
    } finally {
      await app.stop({ graceMs: 0 });
    }
  });

  test('plain HTTP on every interface, cookies without Secure and a catch-all proxy range fail', async () => {
    const dir = fresh();
    const { config } = production(dir, { CLAWROUTER_HOST: '0.0.0.0', CLAWROUTER_TRUSTED_PROXIES: '', CLAWROUTER_COOKIE_SECURE: 'false' });
    const checks = await runSecurityChecks(config, null, null, SAFE_PROCESS);
    expect(find(checks, 'https', 'error')!.message).toContain('plain HTTP on 0.0.0.0');
    expect(levels(checks, 'cookies')).toEqual(['error']);

    const catchAll = await runSecurityChecks(production(fresh(), { CLAWROUTER_TRUSTED_PROXIES: '0.0.0.0/0' }).config, null, null, SAFE_PROCESS);
    expect(find(catchAll, 'trusted proxies', 'error')!.message).toContain('trusts every address');
    const wide = await runSecurityChecks(production(fresh(), { CLAWROUTER_TRUSTED_PROXIES: '10.0.0.0/8' }).config, null, null, SAFE_PROCESS);
    expect(levels(wide, 'trusted proxies')).toEqual(['warn']);
    // Behind a proxy but listening everywhere: the proxy (and its TLS) can be bypassed.
    const bypass = await runSecurityChecks(production(fresh(), { CLAWROUTER_HOST: '0.0.0.0' }).config, null, null, SAFE_PROCESS);
    expect(find(bypass, 'https', 'warn')!.message).toContain('bypass');
  });

  test('a readable key file and database fail, wide backups warn, and --fix repairs them', async () => {
    const dir = fresh();
    const { config, keyFile } = production(dir);
    const app = await deployment(config);
    await app.stop({ graceMs: 0 });
    chmodSync(keyFile, 0o644);
    chmodSync(config.database.path, 0o644);
    mkdirSync(config.database.backupDir, { mode: 0o755 });
    chmodSync(config.database.backupDir, 0o755);
    const box = createSecretBox(parseSecretKey(await Bun.file(keyFile).text()));
    const checks = await runSecurityChecks(config, box, null, SAFE_PROCESS);
    expect(find(checks, 'secret key', 'error')!.message).toContain('0644');
    expect(find(checks, 'database', 'error')!.message).toContain('database permissions too broad');
    expect(find(checks, 'backups', 'warn')!.message).toContain('backup directory permissions too broad');

    const plan = plannedRepairs(checks).map((r) => r.id);
    expect(plan).toEqual(['key-permissions', 'file-permissions']);
    const results = await applyRepairs(config, box, plannedRepairs(checks), { version: 't' });
    expect(results.every((r) => r.ok)).toBe(true);
    const after = await runSecurityChecks(config, box, null, SAFE_PROCESS);
    expect(after.filter((c) => c.level === 'error')).toEqual([]);
    expect(levels(after, 'backups')).toEqual([]);
  });

  test('the secret key kept beside the database is a warning (SEC-011)', async () => {
    const dir = fresh();
    mkdirSync(join(dir, 'data'), { mode: 0o700 });
    const keyFile = join(dir, 'data', 'secret.key');
    writeFileSync(keyFile, `${generateSecretKey()}\n`, { mode: 0o600 });
    const { config } = production(dir, { CLAWROUTER_SECRET_KEY_FILE: keyFile });
    expect(find(await runSecurityChecks(config, null, null, SAFE_PROCESS), 'secret key', 'warn')!.message).toContain('in the data directory');
  });

  test('settings that store or expose more warn: the MCP server, full request logging, captures, a plain-http provider elsewhere', async () => {
    const dir = fresh();
    const { config, keyFile } = production(dir, { CLAWROUTER_OUTBOUND_ALLOWLIST: '10.0.0.0/8, 127.0.0.1' });
    const app = await deployment(config);
    await app.providers.create(actor, { name: 'Ollama', identifier: 'lan', kind: 'openai_compatible', endpoint: 'http://10.1.2.3:11434/v1' }, client);
    await app.providers.create(actor, { name: 'Local', identifier: 'local', kind: 'openai_compatible', endpoint: 'http://127.0.0.1:11434/v1' }, client);
    await app.stop({ graceMs: 0 });
    const db = openSqlite({ path: config.database.path });
    const settings = createSqliteSettingsRepository(db);
    settings.set('system.mcp_enabled', 1);
    settings.set('system.request_logging', 2);
    settings.set('system.captures_enabled', 1);
    db.close();
    const box = createSecretBox(parseSecretKey(await Bun.file(keyFile).text()));
    const checks = await runSecurityChecks(config, box, null, SAFE_PROCESS);
    expect(find(checks, 'mcp', 'warn')!.message).toContain('the MCP server is on');
    expect(find(checks, 'request logging', 'warn')!.message).toContain('request logging contains prompt content');
    expect(levels(checks, 'captures')).toEqual(['warn']);
    const insecure = find(checks, 'providers', 'warn')!.message;
    expect(insecure).toContain('lan');
    expect(insecure).not.toContain('local'); // plain http on this machine only
    expect(checks.filter((c) => c.level === 'error')).toEqual([]);
  });

  test('a credential, API key or session stored in plain text fails', async () => {
    const dir = fresh();
    const { config, keyFile } = production(dir);
    const app = await deployment(config);
    const created = await app.apiKeys.create({ id: app.db.get<{ id: string }>('SELECT id FROM users')!.id, username: 'owner' }, { name: 'leaky' }, client);
    await app.stop({ graceMs: 0 });
    const db = openSqlite({ path: config.database.path });
    // What a broken change could do: write values without hashing or encrypting them.
    db.run("UPDATE provider_credentials SET ciphertext = 'sk-plain-text-provider-key'");
    db.run('UPDATE api_keys SET secret_hash = ? WHERE id = ?', [created.secret, created.key.id]);
    createSqliteSettingsRepository(db).set('notes.example', `use ${created.secret}`);
    db.close();
    const box = createSecretBox(parseSecretKey(await Bun.file(keyFile).text()));
    const checks = await runSecurityChecks(config, box, null, SAFE_PROCESS);
    expect(find(checks, 'credentials', 'error')!.message).toContain('not encrypted');
    const keys = find(checks, 'api keys', 'error')!.message;
    expect(keys).toContain('1 API key(s) stored without a SHA-256 hash');
    expect(keys).toContain('contain a full API key');
    // The check names the problem, never the value.
    expect(JSON.stringify(checks)).not.toContain(created.secret);
    expect(JSON.stringify(checks)).not.toContain('sk-plain-text');
  });

  test('the server process: root fails; capabilities and no no-new-privileges warn', async () => {
    const { config } = production(fresh());
    const root0 = await runSecurityChecks(config, null, null, { ...SAFE_PROCESS, procRoot: proc({ uid: 0 }), container: true });
    expect(find(root0, 'process', 'error')!.message).toContain('container running as root');
    const caps = await runSecurityChecks(config, null, null, { ...SAFE_PROCESS, procRoot: proc({ uid: 1000, capEff: '0000000000000400', noNewPrivs: 0 }) });
    expect(levels(caps, 'process')).toEqual(['ok', 'warn', 'warn']);
    expect(readProcessPrivileges(4242, proc({ uid: 5, capEff: '00000000a80425fb' }))).toEqual({ uid: 5, capEff: 0xa80425fbn, noNewPrivs: true, seccomp: 2 });
    expect(readProcessPrivileges(1, join(root, 'no-such-proc'))).toBeNull();
  });

  test('a reverse proxy that adds wildcard CORS or loses the Origin header fails', async () => {
    const { config } = production(fresh());
    // Stand-ins for a misconfigured proxy in front of ClawRouter.
    const corsProxy = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('{"error":{"message":"Cross-site request rejected."}}', { status: 403, headers: { 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' } }) });
    const originLost = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('{}', { status: 200 }) });
    try {
      const cors = await runSecurityChecks(config, null, null, { ...SAFE_PROCESS, probe: true, url: corsProxy.url.href });
      expect(find(cors, 'cors', 'error')!.message).toContain('wildcard CORS');
      expect(levels(cors, 'csrf')).toEqual(['ok']);
      const lost = await runSecurityChecks(config, null, null, { ...SAFE_PROCESS, probe: true, url: originLost.url.href });
      expect(find(lost, 'csrf', 'error')!.message).toContain('did not refuse a cross-site POST');
      const away = await runSecurityChecks(config, null, null, { ...SAFE_PROCESS, probe: true, url: 'http://127.0.0.1:9', timeoutMs: 500 });
      expect(levels(away, 'probe')).toEqual(['warn']);
    } finally {
      corsProxy.stop(true);
      originLost.stop(true);
    }
  });

  test('the command prints the PASS / WARN / FAIL report and fails on a FAIL', () => {
    const dir = fresh();
    const db = openSqlite({ path: join(dir, 'clawrouter.db') });
    runMigrations(db, migrations);
    db.close();
    chmodSync(join(dir, 'clawrouter.db'), 0o644);
    const env = { PATH: process.env.PATH ?? '', HOME: dir, CLAWROUTER_DATABASE_PATH: join(dir, 'clawrouter.db'), CLAWROUTER_SECRET_KEY: generateSecretKey() };
    const run = Bun.spawnSync(['bun', join(repo, 'scripts', 'doctor.ts'), '--security'], { env, cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    const text = run.stdout.toString();
    expect(text.startsWith('CLAWROUTER SECURITY CHECK')).toBe(true);
    expect(text).toContain('[PASS] mcp: MCP disabled');
    expect(text).toMatch(/\[FAIL\] database: database permissions too broad/);
    expect(text).toContain('run "bun run doctor --security --fix"');
    expect(run.exitCode).toBe(1);
    const json = Bun.spawnSync(['bun', join(repo, 'scripts', 'doctor.ts'), '--security', '--json'], { env, cwd: repo, stdout: 'pipe' });
    expect((JSON.parse(json.stdout.toString()) as Checks).some((c) => c.area === 'cors')).toBe(true);
    const badUrl = Bun.spawnSync(['bun', join(repo, 'scripts', 'doctor.ts'), '--url', 'http://x'], { env, cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    expect(badUrl.exitCode).toBe(2);
  });
});
