/**
 * Checks a ClawRouter deployment without changing anything (configuration,
 * secret key, database, migrations, encrypted values, HTTPS, backups, disk).
 *
 *   bun run doctor           human-readable
 *   bun run doctor --json    for monitoring
 *
 * Exits with 1 when something is wrong (✖), 0 otherwise.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AppError, loadConfig, silentLogger, type SecretBox } from '@clawrouter/core';
import { runDoctor } from '../apps/server/src/doctor.ts';
import { loadSecretBox } from '../apps/server/src/secret-key.ts';

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(`✖ configuration: ${error instanceof AppError ? error.message : error}`);
  process.exit(1);
}
let box: SecretBox | null = null;
let keyError: string | null = null;
// In development the key file is generated at first start: do not create it here (doctor changes nothing).
const devKey = join(dirname(resolve(config.database.path)), 'secret.key');
if (!config.secrets.key && !config.secrets.keyFile && config.database.path !== ':memory:' && !existsSync(devKey)) keyError = 'none yet (a development key is generated at first start)';
else {
  try {
    box = loadSecretBox(config, silentLogger);
  } catch (error) {
    keyError = error instanceof Error ? error.message : String(error);
  }
}
const checks = await runDoctor(config, box, keyError);
if (process.argv.includes('--json')) console.log(JSON.stringify(checks, null, 2));
else {
  const mark = { ok: '✔', warn: '!', error: '✖', info: '·' } as const;
  for (const c of checks) {
    console.log(`${mark[c.level]} ${c.area}: ${c.message}`);
    if (c.fix) console.log(`    → ${c.fix}`);
  }
  const errors = checks.filter((c) => c.level === 'error').length;
  const warnings = checks.filter((c) => c.level === 'warn').length;
  console.log(`\n${errors ? `${errors} problem(s)` : 'No problems'}${warnings ? `, ${warnings} warning(s)` : ''}.`);
}
process.exit(checks.some((c) => c.level === 'error') ? 1 : 0);
