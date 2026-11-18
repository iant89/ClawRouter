/**
 * The outside-in audit: `bun run audit` (add `--no-build` to reuse dist/).
 *
 * Builds the production bundle, starts it with a fresh database, a secret-key file,
 * the mock providers and a local SMTP server, and checks what ClawRouter's docs claim
 * by using it as an attacker or operator would: HTTP, WebSocket and the command-line
 * tools only. Takes about five minutes (some checks wait for clocks and windows).
 * Writes audit-results.json in a temporary folder and exits 1 if any check fails.
 * See docs/audit-2026-11-17.md.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startMockProviders } from '../../tests/support/mock-providers.ts';
import { startMockSmtp } from '../../tests/support/mock-smtp.ts';
import { Client, Recorder } from './lib.ts';
import * as gw from './probes-gateway.ts';
import * as ops from './probes-ops.ts';
import * as web from './probes-web.ts';
import { startServer } from './server.ts';

const root = resolve(import.meta.dir, '../..');
const dist = join(root, 'dist');
const args = new Set(process.argv.slice(2));

if (!args.has('--no-build')) {
  console.log('Building the production bundle…');
  rmSync(dist, { recursive: true, force: true });
  const b = Bun.spawnSync(['bun', 'run', 'build'], { cwd: root, stdout: 'ignore', stderr: 'pipe' });
  if (b.exitCode !== 0) {
    console.error(b.stderr.toString());
    process.exit(2);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'clawrouter-audit-'));
const secretFile = join(dir, 'secret.key');
writeFileSync(secretFile, Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'), { mode: 0o600 });
const setupToken = `audit-setup-${crypto.randomUUID()}`;
const providerKey = `sk-audit-provider-${crypto.randomUUID().replaceAll('-', '')}`;
const mock = startMockProviders(providerKey);
const smtp = startMockSmtp();
const db = join(dir, 'audit.db');
const server = await startServer(dist, dir, 'server', { CLAWROUTER_DATABASE_PATH: db, CLAWROUTER_SECRET_KEY_FILE: secretFile, CLAWROUTER_SETUP_TOKEN: setupToken });
console.log(`Server ${server.base} (pid ${server.pid}); work folder ${dir}\n`);

const r = new Recorder();
const w: web.World = {
  r, base: server.base, dist, dir, db, env: server.env, mock, smtp, setupToken, providerKey,
  admin: new Client(server.base, 'admin'), users: {}, roles: {}, planted: [], gatewayKey: '', providerId: '',
  serverLog: () => readFileSync(server.log, 'utf8'),
};

const sections: [string, (w: web.World) => Promise<void>][] = [
  ['surface', web.surface], ['setup', web.setup], ['sign-in', web.signIn], ['csrf', web.csrf], ['people', web.people],
  ['authorization', web.authorization], ['other users', web.otherUsers], ['key rules', web.keyRules], ['secrets', web.secrets],
  ['gateway', gw.gateway], ['input', gw.input], ['limits', gw.limits], ['quotas', gw.quotas], ['routing', gw.routing],
  ['mcp', gw.mcp], ['notices', gw.notices], ['captures', gw.captures], ['ssrf', gw.ssrf], ['real-time', gw.realtime],
  ['two-factor', gw.twoFactor], ['sessions', gw.sessions], ['html injection', gw.htmlInjection],
  ['operations', ops.operations], ['https and proxies', ops.httpsAndProxy], ['slow', gw.slow], ['leak sweep', web.leakSweep],
];

const started = Date.now();
for (const [name, run] of sections) {
  console.log(`\n— ${name}`);
  try {
    await run(w);
  } catch (error) {
    r.error(name, name, error);
  }
}
await server.stop();
mock.stop();
smtp.stop();

const fails = r.results.filter((x) => x.outcome === 'fail');
const report = join(dir, 'audit-results.json');
writeFileSync(report, JSON.stringify({ when: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), results: r.results }, null, 2));
console.log(`\n${r.results.filter((x) => x.outcome === 'pass').length} passed, ${fails.length} failed, ${r.results.filter((x) => x.outcome === 'note').length} notes in ${Math.round((Date.now() - started) / 1000)} s.`);
for (const f of fails) console.log(`  FAIL ${f.id} ${f.area}: ${f.claim}${f.detail ? ` — ${f.detail}` : ''}`);
console.log(`Results: ${report}`);
process.exit(fails.length ? 1 : 0);
