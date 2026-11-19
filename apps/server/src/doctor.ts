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
import { chmodSync, existsSync, readFileSync, rmSync, statfsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createAuditService, createSqliteAuditRepository } from '@clawrouter/audit';
import { checkSealedSecrets, silentLogger, type Config, type Logger, type SecretBox } from '@clawrouter/core';
import { migrations, migrationStatus, openSqlite, runMigrations } from '@clawrouter/database';
import { createBackup, listBackups, pruneBackups, runningServer } from './backup.ts';
import { clearUnreadable } from './clear-credentials.ts';
import { sealedSecretStores } from './secret-stores.ts';

export type CheckLevel = 'ok' | 'warn' | 'error' | 'info';

/** Problems `doctor --fix` can repair. */
export type RepairId = 'stale-pid' | 'key-permissions' | 'backup' | 'migrate' | 'clear-credentials';
export interface DoctorRepair {
  id: RepairId;
  /** What the repair will do, in a sentence. */
  action: string;
  /** Loses data (stored values must be entered again): only with an explicit flag. */
  destructive?: boolean;
}

export interface DoctorCheck {
  level: CheckLevel;
  area: string;
  message: string;
  /** What to do about it. */
  fix?: string;
  /** Present when `doctor --fix` can repair it. */
  repair?: DoctorRepair;
}

/** The process-ID file a running server writes next to its database. */
export const pidFile = (dbPath: string) => `${resolve(dbPath)}.pid`;

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];
const DAY = 86_400_000;

/**
 * `bun run doctor` (phase 17): checks a deployment without changing anything:
 * configuration, secret key, database, migrations, encrypted values, HTTPS,
 * backups and disk space. Never prints secrets.
 */
export async function runDoctor(config: Config, box: SecretBox | null, keyError: string | null, now = new Date()): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const add = (level: CheckLevel, area: string, message: string, fix?: string, repair?: DoctorRepair) =>
    out.push({ level, area, message, ...(fix ? { fix } : {}), ...(repair ? { repair } : {}) });

  add(config.env === 'production' ? 'ok' : 'warn', 'environment', `CLAWROUTER_ENV is ${config.env}`, config.env === 'production' ? undefined : 'Set CLAWROUTER_ENV=production on a server (secure cookies, JSON logs, a required secret key).');

  // Secret key
  if (keyError?.startsWith('none yet')) add('info', 'secret key', keyError, 'Set CLAWROUTER_SECRET_KEY_FILE before storing provider keys on a server.');
  else if (keyError || !box) add('error', 'secret key', `cannot be loaded: ${keyError ?? 'unknown error'}`, 'Set CLAWROUTER_SECRET_KEY or CLAWROUTER_SECRET_KEY_FILE (openssl rand -base64 32).');
  else {
    const source = config.secrets.key ? 'CLAWROUTER_SECRET_KEY' : config.secrets.keyFile ? `file ${config.secrets.keyFile}` : 'a generated development file next to the database';
    add(config.secrets.key || config.secrets.keyFile ? 'ok' : 'warn', 'secret key', `loaded from ${source} (fingerprint ${box.fingerprint})`,
      config.secrets.key || config.secrets.keyFile ? undefined : 'Set CLAWROUTER_SECRET_KEY_FILE in production, and keep a copy of the key apart from the database backups.');
    if (config.secrets.keyFile && existsSync(config.secrets.keyFile) && (statSync(config.secrets.keyFile).mode & 0o077)) {
      add('warn', 'secret key', `${config.secrets.keyFile} can be read by other users`, `chmod 600 ${config.secrets.keyFile}`,
        { id: 'key-permissions', action: `Make ${config.secrets.keyFile} readable by its owner only (chmod 600).` });
    }
  }

  // Database and migrations
  const dbPath = config.database.path;
  if (dbPath === ':memory:') add('warn', 'database', 'in memory: everything is lost on restart', 'Set CLAWROUTER_DATABASE_PATH to a file.');
  else if (!existsSync(dbPath)) add('info', 'database', `${dbPath} does not exist yet; it is created on first start`);
  else {
    const pid = runningServer(dbPath);
    const db = openSqlite({ path: dbPath, readonly: true });
    try {
      const quick = db.all<{ quick_check: string }>('PRAGMA quick_check').map((r) => r.quick_check);
      add(quick.length === 1 && quick[0] === 'ok' ? 'ok' : 'error', 'database', `${dbPath}: ${(statSync(dbPath).size / 1048576).toFixed(1)} MB, integrity ${quick.join('; ')}`,
        quick[0] === 'ok' ? undefined : 'Restore the latest backup (bun run restore).');
      const applied = new Set(db.all<{ id: string }>("SELECT id FROM schema_migrations").map((r) => r.id));
      const unknown = [...applied].filter((id) => !migrations.some((m) => m.id === id));
      const pending = migrations.filter((m) => !applied.has(m.id));
      if (unknown.length) add('error', 'migrations', `the database comes from a newer ClawRouter (${unknown.join(', ')})`, 'Run the newer version, or restore a backup made with this one.');
      else if (pending.length) add(config.database.migrations === 'manual' ? 'error' : 'warn', 'migrations', `${pending.length} pending (${pending.map((m) => m.id).join(', ')})`,
        pid ? `Stop ClawRouter (process ${pid}) to apply them with "doctor --fix", or they run at the next start${config.database.migrations === 'manual' ? ' once you run "bun run migrate"' : ''}.`
          : config.database.migrations === 'manual' ? 'Back up, then run "bun run migrate".' : `They run at the next start${config.database.backupBeforeMigrate ? ', after an automatic backup' : ''}.`,
        // Only while the server is stopped: migrating under a running server would change its schema.
        pid || !box ? undefined : { id: 'migrate', action: `Back up the database, then apply ${pending.length} pending migration(s).` });
      else add('ok', 'migrations', `up to date (${applied.size})`);
      const users = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
      if (!users) add('info', 'setup', 'no administrator yet', 'Open the console at /setup with the setup token.');
      if (box) {
        const checks = await checkSealedSecrets(sealedSecretStores(db), box);
        const bad = checks.filter((c) => !c.ok);
        if (!checks.length) add('ok', 'encrypted values', 'none stored yet');
        else if (!bad.length) add('ok', 'encrypted values', `all ${checks.length} open with this key`);
        else add('error', 'encrypted values', `${bad.length} of ${checks.length} cannot be opened with this key: ${bad.map((c) => c.secret.label).join(', ')}`,
          'If the key was replaced by mistake, configure the old one again. If it is lost for good, run "bun run clear-credentials" (or "doctor --fix --clear-unreadable") and enter those values again.',
          { id: 'clear-credentials', action: `Back up, then forget the ${bad.length} value(s) this key cannot open; they must be entered again.`, destructive: true });
      }
    } catch (error) {
      add('error', 'database', `cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      db.close();
    }
    add('info', 'server', pid ? `running (process ${pid})` : 'not running');
    if (!pid && existsSync(pidFile(dbPath))) {
      add('warn', 'server', `${pidFile(dbPath)} names a process that is not running (left by a crash)`, 'Remove the file.',
        { id: 'stale-pid', action: `Remove the stale process-ID file ${pidFile(dbPath)}.` });
    }
  }

  // HTTPS and network exposure
  const exposed = !LOOPBACK.includes(config.server.host);
  if (config.server.tls) {
    for (const [what, file] of [['certificate', config.server.tls.certFile], ['private key', config.server.tls.keyFile]] as const) {
      if (!existsSync(file)) add('error', 'https', `${what} ${file} does not exist`);
    }
    if (existsSync(config.server.tls.certFile)) {
      try {
        const cert = new X509Certificate(readFileSync(config.server.tls.certFile));
        const days = Math.floor((Date.parse(cert.validTo) - now.getTime()) / DAY);
        add(days < 0 ? 'error' : days < 21 ? 'warn' : 'ok', 'https', `serving HTTPS; the certificate for ${cert.subject.replace(/\n/g, ', ')} ${days < 0 ? 'has expired' : `expires in ${days} days`}`, days < 21 ? 'Renew the certificate, then restart ClawRouter.' : undefined);
      } catch {
        add('error', 'https', `${config.server.tls.certFile} is not a PEM certificate`);
      }
    }
  } else if (exposed && !config.server.trustedProxies.length) {
    add('warn', 'https', `listening on ${config.server.host} over plain HTTP, without a trusted reverse proxy`, 'Serve HTTPS: put ClawRouter behind a TLS proxy (and set CLAWROUTER_TRUSTED_PROXIES), or set CLAWROUTER_TLS_CERT_FILE and CLAWROUTER_TLS_KEY_FILE.');
  } else add('ok', 'https', exposed ? `behind ${config.server.trustedProxies.length} trusted proxy address(es)` : `listening on ${config.server.host} only`);
  if (!config.auth.cookieSecure && (exposed || config.env === 'production')) add('warn', 'cookies', 'session cookies are not marked Secure', 'Serve HTTPS and leave CLAWROUTER_COOKIE_SECURE unset (or true).');

  // Backups
  if (dbPath !== ':memory:') {
    const backups = listBackups(config.database.backupDir).filter((b) => b.manifest);
    const latest = backups[0]?.manifest;
    const backupNow: DoctorRepair | undefined = box && existsSync(dbPath) ? { id: 'backup', action: `Take a backup now, into ${config.database.backupDir}.` } : undefined;
    if (!latest) add(config.env === 'production' ? 'warn' : 'info', 'backups', `none in ${config.database.backupDir}`, 'Run "bun run backup", and schedule backups (CLAWROUTER_BACKUP_INTERVAL_HOURS or cron).', backupNow);
    else {
      const ageHours = (now.getTime() - Date.parse(latest.createdAt)) / 3_600_000;
      const stale = config.database.backupIntervalHours > 0 ? ageHours > config.database.backupIntervalHours * 2 : ageHours > 7 * 24;
      add(stale ? 'warn' : 'ok', 'backups', `${backups.length} in ${config.database.backupDir}; the newest is ${ageHours < 1 ? 'under an hour' : `${Math.round(ageHours)} hours`} old`,
        stale ? 'Check that scheduled backups run.' : undefined, stale ? backupNow : undefined);
      if (box && latest.secretKey.fingerprint !== box.fingerprint) add('warn', 'backups', `the newest backup was made with another key (${latest.secretKey.fingerprint})`, 'Keep that key until a backup made with the current key exists.');
    }
    if (config.env === 'production' && config.database.backupIntervalHours === 0) add('info', 'backups', 'no scheduled backups in ClawRouter (CLAWROUTER_BACKUP_INTERVAL_HOURS=0)', 'Fine if backups are scheduled elsewhere; copy them off this machine either way.');
    if (resolve(config.database.backupDir).startsWith(dirname(resolve(dbPath)))) add('info', 'backups', 'backups are on the same disk as the database', 'Copy them to another machine or storage as well.');
  }

  // Disk space
  try {
    const target = dbPath === ':memory:' ? '.' : existsSync(dirname(resolve(dbPath))) ? dirname(resolve(dbPath)) : '.';
    const fs = statfsSync(target);
    const free = (fs.bavail * fs.bsize) / 1073741824;
    add(free < 1 ? 'warn' : 'ok', 'disk', `${free.toFixed(1)} GB free where the database lives`, free < 1 ? 'Free some space: SQLite, backups and logs need room to grow.' : undefined);
  } catch {
    // Not every platform reports it.
  }
  return out;
}

/** The repairs a set of checks offers, in the order they are applied. */
export function plannedRepairs(checks: DoctorCheck[], { includeDestructive = false } = {}): DoctorRepair[] {
  const order: RepairId[] = ['stale-pid', 'key-permissions', 'backup', 'migrate', 'clear-credentials'];
  const seen = new Set<RepairId>();
  return checks
    .map((c) => c.repair)
    .filter((r): r is DoctorRepair => !!r && (includeDestructive || !r.destructive))
    .filter((r) => !seen.has(r.id) && seen.add(r.id))
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

export interface RepairResult {
  id: RepairId;
  ok: boolean;
  message: string;
}

/**
 * `doctor --fix`: applies the repairs `runDoctor` offered, one by one, and reports each.
 * Every precondition is checked again here (the server may have started in the meantime).
 * Each repair is recorded in the audit log (`DOCTOR_REPAIR`, done or failed); backups and
 * credential clearing also write their own records. A destructive
 * repair always takes a backup first.
 */
export async function applyRepairs(config: Config, box: SecretBox | null, repairs: DoctorRepair[], { version, log = silentLogger }: { version: string; log?: Logger }): Promise<RepairResult[]> {
  const results: RepairResult[] = [];
  const dbPath = config.database.path;
  // Each repair, done or failed, goes to the audit log as the command line. Nothing is
  // recorded when there is no database file (one is never created just for this).
  const recordRepair = (result: RepairResult) => {
    if (dbPath === ':memory:' || !existsSync(dbPath)) return;
    const db = openSqlite({ path: dbPath });
    try {
      createAuditService(createSqliteAuditRepository(db), log).record({
        action: 'DOCTOR_REPAIR', result: result.ok ? 'SUCCESS' : 'FAILURE', resource: 'system', resourceId: result.id,
        actor: { id: null, name: 'command line' }, ip: null, requestId: null,
        metadata: { repair: result.id, outcome: result.message },
      });
    } finally {
      db.close();
    }
  };
  const backup = async (label: string) => {
    const db = openSqlite({ path: dbPath });
    try {
      const { path } = await createBackup(db, { dir: config.database.backupDir, box: box!, version, label, log });
      // Automatic kinds keep the configured number; manual backups are never pruned here.
      if (label !== 'manual') pruneBackups(config.database.backupDir, label, config.database.backupKeep);
      return path;
    } finally {
      db.close();
    }
  };

  for (const r of repairs) {
    try {
      switch (r.id) {
        case 'stale-pid': {
          if (runningServer(dbPath)) throw new Error('ClawRouter is running now; the file is in use.');
          rmSync(pidFile(dbPath), { force: true });
          results.push({ id: r.id, ok: true, message: `Removed ${pidFile(dbPath)}.` });
          break;
        }
        case 'key-permissions': {
          chmodSync(config.secrets.keyFile!, 0o600);
          results.push({ id: r.id, ok: true, message: `${config.secrets.keyFile} is now readable by its owner only.` });
          break;
        }
        case 'backup': {
          if (!box) throw new Error('The secret key cannot be loaded.');
          results.push({ id: r.id, ok: true, message: `Backed up to ${await backup('manual')}.` });
          break;
        }
        case 'migrate': {
          if (!box) throw new Error('The secret key cannot be loaded.');
          const pid = runningServer(dbPath);
          if (pid) throw new Error(`ClawRouter is running (process ${pid}); stop it first.`);
          const path = await backup('pre-migrate');
          const db = openSqlite({ path: dbPath });
          try {
            const ran = runMigrations(db, migrations, log);
            const left = migrationStatus(db, migrations).filter((m) => !m.appliedAt).length;
            results.push({ id: r.id, ok: left === 0, message: `Backed up to ${path}, then applied ${ran.length} migration(s)${left ? `; ${left} still pending` : ''}.` });
          } finally {
            db.close();
          }
          break;
        }
        case 'clear-credentials': {
          if (!box) throw new Error('The secret key cannot be loaded.');
          if (!r.destructive) throw new Error('Not marked destructive.');
          const path = await backup('pre-repair');
          const db = openSqlite({ path: dbPath });
          try {
            const cleared = await clearUnreadable(db, box, log);
            results.push({ id: r.id, ok: true, message: `Backed up to ${path}, then forgot ${cleared.length} value(s): ${cleared.map((c) => `${c.label} (${c.consequence})`).join('; ') || 'none'}.` });
          } finally {
            db.close();
          }
          break;
        }
      }
    } catch (error) {
      results.push({ id: r.id, ok: false, message: error instanceof Error ? error.message : String(error) });
    }
    recordRepair(results[results.length - 1]!);
  }
  return results;
}
