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

import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createAuditService, createSqliteAuditRepository } from '@clawrouter/audit';
import { checkSealedSecrets, octal, silentLogger, type Config, type SecretBox } from '@clawrouter/core';
import { createSqliteSettingsRepository, openSqlite, type Database } from '@clawrouter/database';
import { createSettingsService, settingDefaults } from '@clawrouter/settings';
import { ADMIN_ROLE_ID } from '@clawrouter/shared';
import { classifyAddress, parseCidr } from '@clawrouter/security';
import { holdsSecretKey, listBackups, runningServer } from './backup.ts';
import { tooOpen, type CheckLevel, type DoctorCheck, type DoctorRepair } from './doctor.ts';
import { sealedSecretStores } from './secret-stores.ts';

/**
 * `bun run doctor --security` (SEC-025): a security review of one deployment. It reads
 * the configuration, the database (read-only), file modes, the running server's process
 * and, when the server runs (or `url` is given), asks it a few harmless questions over
 * HTTP: a cross-site request must be refused, no CORS header may come back, HTTPS must
 * carry HSTS. Never prints a secret and changes nothing; `--fix` applies the same safe
 * repairs as `doctor`.
 *
 * Levels: `ok` is PASS, `warn` WARN, `error` FAIL (exit status 1), `info` INFO.
 */
export interface SecurityCheckOptions {
  now?: Date;
  /** Ask the running server over HTTP. Default: when it runs (its process-ID file names a live process). */
  probe?: boolean;
  /** The address to ask: a public URL through the reverse proxy, or the server's own. */
  url?: string;
  /** The process to inspect instead of the one in the process-ID file (tests). */
  pid?: number | null;
  /** Where /proc is (tests). */
  procRoot?: string;
  /** Whether this is a container (tests); detected otherwise. */
  container?: boolean;
  /** Probe time limit per request. */
  timeoutMs?: number;
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];
const SEALED = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A full ClawRouter API key anywhere in a text column (it must only ever exist as a hash). */
const FULL_KEY = /crk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}/;
const CROSS_SITE_ORIGIN = 'https://cross-site.doctor.invalid';

const isLoopbackHost = (host: string) => LOOPBACK_HOSTS.includes(host) || classifyAddress(host)?.kind === 'loopback';
const inside = (child: string, parent: string) => resolve(child) === resolve(parent) || resolve(child).startsWith(resolve(parent) + sep);

/** The address the server itself listens on, as a URL this machine can reach. */
export function localServerUrl(config: Config): string {
  const host = config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host === '::' ? '[::1]' : config.server.host.includes(':') ? `[${config.server.host}]` : config.server.host;
  return `${config.server.tls ? 'https' : 'http'}://${host}:${config.server.port}`;
}

/** What /proc says about a process: real user, effective capabilities, no-new-privileges, seccomp. */
export interface ProcessPrivileges {
  uid: number;
  capEff: bigint;
  noNewPrivs: boolean;
  seccomp: number;
}

export function readProcessPrivileges(pid: number, procRoot = '/proc'): ProcessPrivileges | null {
  try {
    const status = readFileSync(join(procRoot, String(pid), 'status'), 'utf8');
    const field = (name: string) => status.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim();
    const uid = Number(field('Uid')?.split(/\s+/)[0]);
    const cap = field('CapEff');
    if (!Number.isInteger(uid) || cap === undefined) return null;
    return { uid, capEff: BigInt(`0x${cap}`), noNewPrivs: field('NoNewPrivs') === '1', seccomp: Number(field('Seccomp') ?? 0) };
  } catch {
    return null; // not Linux, or another account's process with hidepid
  }
}

/** Running inside Docker, Podman or Kubernetes. */
export function inContainer(procRoot = '/proc'): boolean {
  if (existsSync('/.dockerenv') || existsSync('/run/.containerenv')) return true;
  try {
    return /docker|kubepods|containerd|libpod/.test(readFileSync(join(procRoot, '1', 'cgroup'), 'utf8'));
  } catch {
    return false;
  }
}

/** Effective settings (console value, else environment, else built-in), read from the database. */
function readSettings(db: Database, config: Config) {
  return createSettingsService({ repo: createSqliteSettingsRepository(db), defaults: settingDefaults(config), audit: createAuditService(createSqliteAuditRepository(db), silentLogger) });
}

interface ProbeResult {
  status: number;
  headers: Headers;
  body: string;
}

async function ask(url: string, init: RequestInit, timeoutMs: number): Promise<ProbeResult | string> {
  try {
    // Only ClawRouter's own address (or the one the operator named) is asked; a self-signed
    // certificate must not stop the check, so the certificate is not verified here (the
    // certificate itself is checked from its file).
    const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), tls: { rejectUnauthorized: false } } as RequestInit);
    return { status: res.status, headers: res.headers, body: await res.text() };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function runSecurityChecks(config: Config, box: SecretBox | null, keyError: string | null, options: SecurityCheckOptions = {}): Promise<DoctorCheck[]> {
  const now = options.now ?? new Date();
  const out: DoctorCheck[] = [];
  const add = (level: CheckLevel, area: string, message: string, fix?: string, repair?: DoctorRepair) =>
    out.push({ level, area, message, ...(fix ? { fix } : {}), ...(repair ? { repair } : {}) });
  const production = config.env === 'production';
  const exposed = !isLoopbackHost(config.server.host);
  const dbPath = config.database.path;
  const dbExists = dbPath !== ':memory:' && existsSync(dbPath);
  const pid = options.pid !== undefined ? options.pid : dbExists || (dbPath !== ':memory:' && existsSync(`${resolve(dbPath)}.pid`)) ? runningServer(dbPath) : null;

  add(production ? 'ok' : 'warn', 'environment', `CLAWROUTER_ENV is ${config.env}`, production ? undefined : 'Set CLAWROUTER_ENV=production on a server (secure cookies, a required secret key).');

  // --- Transport --------------------------------------------------------------------------
  if (config.server.tls) {
    let certificate = '';
    try {
      const cert = new X509Certificate(readFileSync(config.server.tls.certFile));
      const days = Math.floor((Date.parse(cert.validTo) - now.getTime()) / 86_400_000);
      certificate = days < 0 ? ', but the certificate has expired' : `; the certificate expires in ${days} days`;
      add(days < 0 ? 'error' : 'ok', 'https', `HTTPS configured (served by ClawRouter)${certificate}`, days < 0 ? 'Renew the certificate, then restart ClawRouter.' : undefined);
    } catch {
      add('error', 'https', `HTTPS configured, but ${config.server.tls.certFile} cannot be read as a certificate`, 'Check CLAWROUTER_TLS_CERT_FILE.');
    }
  } else if (exposed && !config.server.trustedProxies.length) {
    add(production ? 'error' : 'warn', 'https', `plain HTTP on ${config.server.host}, with no reverse proxy: passwords, session cookies and API keys cross the network unencrypted`,
      'Put ClawRouter behind a TLS reverse proxy (listen on 127.0.0.1, set CLAWROUTER_TRUSTED_PROXIES), or set CLAWROUTER_TLS_CERT_FILE and CLAWROUTER_TLS_KEY_FILE.');
  } else if (exposed) {
    add('warn', 'https', `HTTPS is left to the reverse proxy, but ClawRouter listens on ${config.server.host}: clients that reach port ${config.server.port} directly bypass it and its TLS`,
      'Listen on 127.0.0.1 (CLAWROUTER_HOST) when the proxy runs on this machine, or let only the proxy reach the port (firewall).');
  } else if (config.server.trustedProxies.length) {
    add('ok', 'https', `HTTPS configured at the reverse proxy; ClawRouter listens on ${config.server.host} only`);
  } else {
    add(production ? 'warn' : 'info', 'https', `listening on ${config.server.host} only, with no HTTPS and no trusted reverse proxy`,
      production ? 'If a TLS reverse proxy runs in front, list it in CLAWROUTER_TRUSTED_PROXIES; otherwise only this machine can use ClawRouter safely.' : undefined);
  }

  if (config.auth.cookieSecure) add('ok', 'cookies', 'secure cookies enabled (Secure, HttpOnly, SameSite=Strict)');
  else add(production || exposed ? 'error' : 'info', 'cookies', 'session cookies are not marked Secure: a browser also sends them over plain HTTP',
    'Serve HTTPS and leave CLAWROUTER_COOKIE_SECURE unset (or true).');

  // --- Trusted proxies ------------------------------------------------------------------
  if (!config.server.trustedProxies.length) add('ok', 'trusted proxies', 'none: X-Forwarded-For is ignored and the connecting address is the client');
  else {
    const broad: string[] = [];
    const catchAll: string[] = [];
    for (const entry of config.server.trustedProxies) {
      const cidr = parseCidr(entry);
      if (!cidr || !entry.includes('/')) continue;
      if (cidr.bits === 0) catchAll.push(entry);
      else if (cidr.bits < (cidr.family === 4 ? 16 : 48)) broad.push(entry);
    }
    if (catchAll.length) add('error', 'trusted proxies', `${catchAll.join(', ')} trusts every address: any client can choose the address ClawRouter sees (rate limits, sign-in lockout and audit records then believe it)`,
      'List only the addresses of your reverse proxies in CLAWROUTER_TRUSTED_PROXIES.');
    else if (broad.length) add('warn', 'trusted proxies', `${broad.join(', ')} is a wide range: every machine in it can choose the client address ClawRouter sees`,
      'Narrow CLAWROUTER_TRUSTED_PROXIES to the proxies themselves.');
    else add('ok', 'trusted proxies', `trusted proxy configuration valid: ${config.server.trustedProxies.join(', ')}`);
  }

  // --- Secret key ----------------------------------------------------------------------
  if (config.secrets.key) {
    add('info', 'secret key', 'given in CLAWROUTER_SECRET_KEY: other programs started with the same environment see it too',
      'Prefer CLAWROUTER_SECRET_KEY_FILE pointing at a file only the service account can read.');
  } else if (config.secrets.keyFile) {
    if (!existsSync(config.secrets.keyFile)) add('error', 'secret key', `${config.secrets.keyFile} does not exist`);
    else {
      const mode = statSync(config.secrets.keyFile).mode & 0o777;
      if (mode & 0o077) add('error', 'secret key', `secret key permissions: ${octal(mode)}: other accounts can read the key that opens every stored credential`, `chmod 600 ${config.secrets.keyFile}`,
        { id: 'key-permissions', action: `Make ${config.secrets.keyFile} readable by its owner only (chmod 600).` });
      else add('ok', 'secret key', `secret key permissions: ${octal(mode)}`);
    }
    if (dbPath !== ':memory:') {
      if (inside(config.secrets.keyFile, config.database.backupDir)) add('warn', 'secret key', 'the secret key file is inside the backup directory: whoever gets the backups gets the key too',
        'Keep the key apart from the database and its backups (SEC-011), e.g. in /etc/clawrouter.');
      else if (inside(config.secrets.keyFile, dirname(resolve(dbPath)))) add('warn', 'secret key', 'the secret key file is in the data directory: a copy of that directory holds both the credentials and the key that opens them',
        'Keep the key apart from the database (SEC-011), e.g. in /etc/clawrouter.');
    }
  } else if (keyError?.startsWith('none yet')) add('info', 'secret key', 'none yet: a development key is generated at first start');
  else add(production ? 'error' : 'info', 'secret key', 'a generated development key next to the database', 'Set CLAWROUTER_SECRET_KEY_FILE in production and keep a copy apart from the backups.');

  // --- Files -----------------------------------------------------------------------------
  const open = tooOpen(config);
  const dbFiles = open.filter((p) => p.what === 'database');
  const backupFiles = open.filter((p) => p.what.includes('backup'));
  const otherFiles = open.filter((p) => !dbFiles.includes(p) && !backupFiles.includes(p));
  const fileRepair: DoctorRepair = { id: 'file-permissions', action: `Remove group and other permissions from ${open.length} file(s) and directory(ies).` };
  const shown = (list: typeof open) => list.slice(0, 5).map((p) => `${p.path} (${octal(p.access.mode)})`).join(', ') + (list.length > 5 ? `, and ${list.length - 5} more` : '');
  if (dbExists) {
    if (dbFiles.length) add('error', 'database', `database permissions too broad: ${shown(dbFiles)}`, 'chmod 600 the database files, or run "doctor --security --fix".', fileRepair);
    else add('ok', 'database', `database permissions: ${octal(statSync(dbPath).mode & 0o777)}`);
  }
  // A readable file is a leak; a directory others may list (the data directory an operator made) only shows names.
  if (otherFiles.length) add(otherFiles.some((p) => !statSync(p.path).isDirectory()) ? 'error' : 'warn', 'files', `other accounts can use ${shown(otherFiles)}`, 'Files 0600, directories 0700, or run "doctor --security --fix".', fileRepair);
  if (backupFiles.length) add('warn', 'backups', `backup directory permissions too broad: ${shown(backupFiles)}`, 'Backups hold every password hash and encrypted credential: chmod 700 the directories and 600 the files, or run "doctor --security --fix".', fileRepair);
  if (dbPath !== ':memory:') {
    const withKey = listBackups(config.database.backupDir).filter((b) => holdsSecretKey(b.manifest)).length;
    if (withKey) add('warn', 'backups', `${withKey} backup(s) beside the ordinary ones contain the secret key`, 'Keep credential backups apart and offline (bun run backup --include-secret-key writes them to credentials/).');
  }

  // --- The database: keys, credentials, settings ------------------------------------------
  if (dbExists) {
    const db = openSqlite({ path: dbPath, readonly: true });
    try {
      const keys = db.all<{ secret_hash: string }>('SELECT secret_hash FROM api_keys');
      const unhashed = keys.filter((k) => !SHA256_HEX.test(k.secret_hash)).length;
      const plainKeys = [
        ...db.all<{ v: string | null }>('SELECT secret_hash || \' \' || name || \' \' || prefix AS v FROM api_keys'),
        ...db.all<{ v: string | null }>('SELECT name || \' \' || purpose || \' \' || COALESCE(decision_note, \'\') AS v FROM api_key_requests'),
        ...db.all<{ v: string | null }>('SELECT value AS v FROM settings'),
      ].filter((r) => r.v && FULL_KEY.test(r.v)).length;
      const sessions = db.all<{ token_hash: string }>('SELECT token_hash FROM sessions').filter((s) => !SHA256_HEX.test(s.token_hash)).length;
      if (unhashed || plainKeys || sessions) {
        add('error', 'api keys', [unhashed && `${unhashed} API key(s) stored without a SHA-256 hash`, plainKeys && `${plainKeys} stored value(s) contain a full API key`, sessions && `${sessions} session(s) stored without a hashed token`].filter(Boolean).join('; '),
          'Revoke the affected keys and sign everyone out; then report it (SECURITY.md): ClawRouter never stores them in plain text.');
      } else add('ok', 'api keys', `API keys hashed (${keys.length} key(s), SHA-256 only; session tokens too)`);

      const secrets = sealedSecretStores(db).flatMap((s) => s.list().map((secret) => ({ store: s.name, secret })));
      const plain = secrets.filter((s) => !SEALED.test(s.secret.ciphertext));
      if (plain.length) add('error', 'credentials', `${plain.length} stored credential(s) are not encrypted: ${plain.slice(0, 5).map((s) => s.secret.label).join(', ')}`, 'Enter them again in the console (they are then encrypted), and rotate them at the provider.');
      else add('ok', 'credentials', secrets.length ? `provider credentials encrypted (${secrets.length} value(s), AES-256-GCM)` : 'provider credentials encrypted (none stored yet)');
      if (box && secrets.length) {
        const unreadable = (await checkSealedSecrets(sealedSecretStores(db), box)).filter((c) => !c.ok).length;
        if (unreadable) add('warn', 'credentials', `${unreadable} encrypted value(s) cannot be opened with the configured key`, 'Run "bun run doctor" for what to do.');
      }

      const providers = db.all<{ identifier: string; endpoint: string }>('SELECT identifier, endpoint FROM providers ORDER BY identifier');
      const plainHttp = providers.filter((p) => p.endpoint.toLowerCase().startsWith('http:'));
      const remote = plainHttp.filter((p) => {
        try {
          return !isLoopbackHost(new URL(p.endpoint).hostname.replace(/^\[|\]$/g, ''));
        } catch {
          return true;
        }
      });
      if (remote.length) add('warn', 'providers', `insecure provider URLs: ${remote.map((p) => p.identifier).join(', ')} use plain http to another machine: prompts, replies and the provider key cross the network unencrypted`,
        'Use https, or keep that model server on this machine or a network you control.');
      else if (plainHttp.length) add('ok', 'providers', `no insecure provider URLs (${plainHttp.length} plain-http endpoint(s) on this machine only: ${plainHttp.map((p) => p.identifier).join(', ')})`);
      else add('ok', 'providers', `no insecure provider URLs (${providers.length} provider(s), all https)`);
      if (config.outbound.allowlist.some((e) => /^(0\.0\.0\.0|::)\/0$/.test(e))) add('warn', 'providers', 'the outbound allowlist has a catch-all range: a provider endpoint can reach every private address on your network', 'List only the hosts or ranges of your local model servers in CLAWROUTER_OUTBOUND_ALLOWLIST.');

      const settings = readSettings(db, config);
      if (settings.get('mcpEnabled')) {
        const withMcp = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM api_keys WHERE mcp_access = 1 AND revoked_at IS NULL")!.n;
        add('warn', 'mcp', `the MCP server is on (/v1/mcp); ${withMcp} active key(s) may use it`, 'Fine if agents need it. Otherwise turn it off: Administration → Settings → API keys and quotas → MCP server.');
      } else add('ok', 'mcp', 'MCP disabled');
      const logging = settings.get('requestLogging');
      if (logging === 2) add('warn', 'request logging', 'request logging contains prompt content (Full): prompts, replies and tool calls are stored', 'Use Metadata unless you need the content: Administration → Settings → Data retention → Request logging.');
      else add('ok', 'request logging', logging === 0 ? 'request logging: None (usage only)' : 'request logging: Metadata (no prompt content)');
      if (settings.get('capturesEnabled')) add('warn', 'captures', 'provider captures are on: failed requests are stored with their message text', 'Turn them off when the bug report is done: Administration → Settings → Data retention → Provider captures.');

      const policy = createSqliteSettingsRepository(db).get('security.sign_in')?.value as { require?: string } | undefined;
      const require = policy?.require ?? 'off';
      const admins = db.all<{ id: string; enrolled: number }>(
        `SELECT u.id, (t.totp_confirmed_at IS NOT NULL OR (t.email_enabled_at IS NOT NULL AND u.email IS NOT NULL)) AS enrolled
         FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role_id = ? LEFT JOIN user_two_factor t ON t.user_id = u.id
         WHERE u.status = 'ACTIVE'`, [ADMIN_ROLE_ID]);
      const without = admins.filter((a) => !a.enrolled).length;
      if (require === 'off') add(without ? 'warn' : 'ok', 'two-factor', `two-factor sign-in is not required${without ? `; ${without} of ${admins.length} administrator(s) sign in with a password alone` : ', but every administrator uses it'}`,
        without ? 'Require it for administrators at least: Administration → Settings → Sign-in and sessions → Two-factor sign-in.' : undefined);
      else add('ok', 'two-factor', `two-factor sign-in required for ${require}`);

      const users = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
      const tokenFile = join(dirname(resolve(dbPath)), 'setup-token');
      if (users && existsSync(tokenFile)) add('warn', 'setup token', `${tokenFile} is still there although setup is done`, 'Delete it.');
      if (users && config.auth.setupToken) add('info', 'setup token', 'CLAWROUTER_SETUP_TOKEN is still set although setup is done', 'Remove it from the environment.');
      if (!users && exposed) add('warn', 'setup token', `setup is not done and ClawRouter listens on ${config.server.host}: whoever has the setup token becomes the administrator`, 'Finish setup now, or listen on 127.0.0.1 until it is done.');
    } catch (error) {
      add('error', 'database', `cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      db.close();
    }
  } else if (dbPath === ':memory:') add('info', 'database', 'in memory: nothing is stored');
  else add('info', 'database', `${dbPath} does not exist yet: stored data is checked once ClawRouter has created it`);

  // --- The server process ----------------------------------------------------------------
  const container = options.container ?? inContainer(options.procRoot);
  const where = container ? 'container' : 'server';
  const target = pid ?? (container ? process.pid : null);
  const privileges = target ? readProcessPrivileges(target, options.procRoot) : null;
  const who = pid ? `the server (process ${pid})` : 'this command';
  if (!privileges) {
    add('info', 'process', pid ? `cannot read the privileges of process ${pid} (another account, or not Linux)` : 'ClawRouter is not running: its process privileges were not checked',
      pid ? 'Run doctor as the account ClawRouter runs as.' : undefined);
  } else {
    if (privileges.uid === 0) add('error', 'process', `${where} running as root: ${who} runs as uid 0`, container ? 'Run the image as its bun user (the Dockerfile does; do not override it with --user 0 or user: root).' : 'Run ClawRouter as its own unprivileged account (deploy/clawrouter.service: User=clawrouter).');
    else add('ok', 'process', `${where} running non-root (${who}: uid ${privileges.uid})`);
    if (privileges.capEff !== 0n) add('warn', 'process', `${who} holds Linux capabilities (CapEff ${privileges.capEff.toString(16).padStart(16, '0')})`, container ? 'Drop them: cap_drop: [ALL] (deploy/compose.yaml).' : 'Clear them: CapabilityBoundingSet= (deploy/clawrouter.service), or only CAP_NET_BIND_SERVICE for ports below 1024.');
    if (!privileges.noNewPrivs) add('warn', 'process', `${who} may gain privileges (no-new-privileges is off)`, container ? 'security_opt: [no-new-privileges:true] (deploy/compose.yaml).' : 'NoNewPrivileges=true (deploy/clawrouter.service).');
    if (privileges.capEff === 0n && privileges.noNewPrivs) add('ok', 'process', `${who}: no capabilities, no-new-privileges${privileges.seccomp === 2 ? ', system calls filtered (seccomp)' : ''}`);
  }

  // --- Asking the running server -----------------------------------------------------------
  const probe = options.probe ?? (pid !== null || !!options.url);
  const csrfFallback = 'CSRF protection enabled (always on: cross-site origins refused, a header required with the session cookie; it cannot be turned off)';
  const corsFallback = 'no wildcard CORS: ClawRouter sends no CORS headers and none can be configured';
  if (!probe) {
    add('ok', 'csrf', csrfFallback);
    add('ok', 'cors', `${corsFallback} (a reverse proxy in front could still add them: run with --url <public address> to ask through it)`);
    return out;
  }
  const base = (options.url ?? localServerUrl(config)).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 3_000;
  const csrf = await ask(`${base}/api/auth/logout`, { method: 'POST', headers: { origin: CROSS_SITE_ORIGIN, 'content-type': 'application/json' }, body: '{}' }, timeoutMs);
  if (typeof csrf === 'string') {
    add('warn', 'probe', `cannot reach ${base}: ${csrf}`, options.url ? 'Check the address.' : 'Is ClawRouter listening where its configuration says? Use --url to name the address.');
    add('ok', 'csrf', csrfFallback);
    add('ok', 'cors', corsFallback);
    return out;
  }
  if (csrf.status === 403 && csrf.body.includes('Cross-site request rejected')) add('ok', 'csrf', `CSRF protection enabled: ${base} refused a cross-site request`);
  else add('error', 'csrf', `${base} did not refuse a cross-site POST (status ${csrf.status})`, options.url ? 'Check that the address reaches ClawRouter, and that the reverse proxy keeps the Origin and Host headers.' : undefined);

  const preflight = await ask(`${base}/v1/chat/completions`, { method: 'OPTIONS', headers: { origin: CROSS_SITE_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' } }, timeoutMs);
  const simple = await ask(`${base}/api/health`, { headers: { origin: CROSS_SITE_ORIGIN } }, timeoutMs);
  const cors = [preflight, simple].filter((r): r is ProbeResult => typeof r !== 'string').map((r) => ({ origin: r.headers.get('access-control-allow-origin'), credentials: r.headers.get('access-control-allow-credentials') }));
  const wildcard = cors.find((c) => c.origin === '*' || c.origin === CROSS_SITE_ORIGIN);
  if (wildcard) add(wildcard.credentials === 'true' || wildcard.origin === CROSS_SITE_ORIGIN ? 'error' : 'warn', 'cors', `wildcard CORS: ${base} allows any origin (Access-Control-Allow-Origin: ${wildcard.origin}${wildcard.credentials ? `, credentials ${wildcard.credentials}` : ''})`,
    'ClawRouter sends no CORS headers: remove the ones your reverse proxy adds, or limit them to the origins that need /v1.');
  else if (cors.some((c) => c.origin)) add('warn', 'cors', `${base} sends CORS headers for some origins (${cors.map((c) => c.origin).filter(Boolean).join(', ')})`, 'ClawRouter sends none: check the reverse proxy.');
  else add('ok', 'cors', `no wildcard CORS: ${base} sent no CORS headers to a cross-site origin`);

  const url = new URL(base);
  if (url.protocol === 'https:' && typeof simple !== 'string') {
    if (simple.headers.get('strict-transport-security')) add('ok', 'https', `${base} sends Strict-Transport-Security`);
    else add('warn', 'https', `${base} does not send Strict-Transport-Security`, 'ClawRouter sends it when cookies are Secure (CLAWROUTER_COOKIE_SECURE); a reverse proxy must pass it on or add it.');
  } else if (options.url && url.protocol === 'http:' && !isLoopbackHost(url.hostname.replace(/^\[|\]$/g, ''))) {
    add('error', 'https', `${base} answers over plain HTTP`, 'Serve the public address over HTTPS only (redirect plain HTTP to HTTPS at the proxy).');
  }
  return out;
}
