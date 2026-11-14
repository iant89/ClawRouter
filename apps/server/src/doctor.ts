import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync, statfsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { checkSealedSecrets, type Config, type SecretBox } from '@clawrouter/core';
import { migrations, openSqlite } from '@clawrouter/database';
import { listBackups, runningServer } from './backup.ts';
import { sealedSecretStores } from './secret-stores.ts';

export type CheckLevel = 'ok' | 'warn' | 'error' | 'info';
export interface DoctorCheck {
  level: CheckLevel;
  area: string;
  message: string;
  /** What to do about it. */
  fix?: string;
}

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];
const DAY = 86_400_000;

/**
 * `bun run doctor` (phase 17): checks a deployment without changing anything:
 * configuration, secret key, database, migrations, encrypted values, HTTPS,
 * backups and disk space. Never prints secrets.
 */
export async function runDoctor(config: Config, box: SecretBox | null, keyError: string | null, now = new Date()): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const add = (level: CheckLevel, area: string, message: string, fix?: string) => out.push({ level, area, message, ...(fix ? { fix } : {}) });

  add(config.env === 'production' ? 'ok' : 'warn', 'environment', `CLAWROUTER_ENV is ${config.env}`, config.env === 'production' ? undefined : 'Set CLAWROUTER_ENV=production on a server (secure cookies, JSON logs, a required secret key).');

  // Secret key
  if (keyError?.startsWith('none yet')) add('info', 'secret key', keyError, 'Set CLAWROUTER_SECRET_KEY_FILE before storing provider keys on a server.');
  else if (keyError || !box) add('error', 'secret key', `cannot be loaded: ${keyError ?? 'unknown error'}`, 'Set CLAWROUTER_SECRET_KEY or CLAWROUTER_SECRET_KEY_FILE (openssl rand -base64 32).');
  else {
    const source = config.secrets.key ? 'CLAWROUTER_SECRET_KEY' : config.secrets.keyFile ? `file ${config.secrets.keyFile}` : 'a generated development file next to the database';
    add(config.secrets.key || config.secrets.keyFile ? 'ok' : 'warn', 'secret key', `loaded from ${source} (fingerprint ${box.fingerprint})`,
      config.secrets.key || config.secrets.keyFile ? undefined : 'Set CLAWROUTER_SECRET_KEY_FILE in production, and keep a copy of the key apart from the database backups.');
    if (config.secrets.keyFile && existsSync(config.secrets.keyFile) && (statSync(config.secrets.keyFile).mode & 0o077)) {
      add('warn', 'secret key', `${config.secrets.keyFile} can be read by other users`, `chmod 600 ${config.secrets.keyFile}`);
    }
  }

  // Database and migrations
  const dbPath = config.database.path;
  if (dbPath === ':memory:') add('warn', 'database', 'in memory: everything is lost on restart', 'Set CLAWROUTER_DATABASE_PATH to a file.');
  else if (!existsSync(dbPath)) add('info', 'database', `${dbPath} does not exist yet; it is created on first start`);
  else {
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
        config.database.migrations === 'manual' ? 'Back up, then run "bun run migrate".' : `They run at the next start${config.database.backupBeforeMigrate ? ', after an automatic backup' : ''}.`);
      else add('ok', 'migrations', `up to date (${applied.size})`);
      const users = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
      if (!users) add('info', 'setup', 'no administrator yet', 'Open the console at /setup with the setup token.');
      if (box) {
        const checks = await checkSealedSecrets(sealedSecretStores(db), box);
        const bad = checks.filter((c) => !c.ok);
        if (!checks.length) add('ok', 'encrypted values', 'none stored yet');
        else if (!bad.length) add('ok', 'encrypted values', `all ${checks.length} open with this key`);
        else add('error', 'encrypted values', `${bad.length} of ${checks.length} cannot be opened with this key: ${bad.map((c) => c.secret.label).join(', ')}`,
          'If the key was replaced by mistake, configure the old one again. If it is lost for good, run "bun run clear-credentials" and enter those values again.');
      }
    } catch (error) {
      add('error', 'database', `cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      db.close();
    }
    const pid = runningServer(dbPath);
    add('info', 'server', pid ? `running (process ${pid})` : 'not running');
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
    if (!latest) add(config.env === 'production' ? 'warn' : 'info', 'backups', `none in ${config.database.backupDir}`, 'Run "bun run backup", and schedule backups (CLAWROUTER_BACKUP_INTERVAL_HOURS or cron).');
    else {
      const ageHours = (now.getTime() - Date.parse(latest.createdAt)) / 3_600_000;
      const stale = config.database.backupIntervalHours > 0 ? ageHours > config.database.backupIntervalHours * 2 : ageHours > 7 * 24;
      add(stale ? 'warn' : 'ok', 'backups', `${backups.length} in ${config.database.backupDir}; the newest is ${ageHours < 1 ? 'under an hour' : `${Math.round(ageHours)} hours`} old`, stale ? 'Check that scheduled backups run.' : undefined);
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
