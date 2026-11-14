/**
 * Re-encrypts every stored secret (provider credentials, mail server password,
 * authenticator-app secrets) with a new secret key.
 *
 *   CLAWROUTER_NEW_SECRET_KEY=<new key> bun run rotate-secret-key
 *   bun run rotate-secret-key --new-key-file /path/to/new.key
 *
 * The current key comes from the usual configuration (CLAWROUTER_SECRET_KEY,
 * CLAWROUTER_SECRET_KEY_FILE, or data/secret.key in development). Stop the
 * server first, rotate, then start it with the new key. Back up the database
 * and both keys before, and make a new backup after.
 */
import { readFileSync } from 'node:fs';
import { AppError, createLogger, createSecretBox, loadConfig, parseSecretKey } from '@clawrouter/core';
import { migrationStatus, migrations, openSqlite } from '@clawrouter/database';
import { rotateSecretKey } from '../apps/server/src/rotate-key.ts';
import { loadSecretBox } from '../apps/server/src/secret-key.ts';

const args = process.argv.slice(2);
const fileFlag = args.indexOf('--new-key-file');
const newKeyText = fileFlag >= 0 ? readFileSync(args[fileFlag + 1] ?? '', 'utf8') : process.env.CLAWROUTER_NEW_SECRET_KEY;
if (!newKeyText || args.includes('--help')) {
  console.error('usage: CLAWROUTER_NEW_SECRET_KEY=<key> bun run rotate-secret-key   (or --new-key-file <path>)');
  console.error('Generate a key with: openssl rand -base64 32');
  process.exit(newKeyText ? 0 : 2);
}

const config = loadConfig();
const log = createLogger({ level: 'warn', format: 'pretty' });
const db = openSqlite({ path: config.database.path });
try {
  if (migrationStatus(db, migrations).some((m) => !m.appliedAt)) {
    console.error('The database has pending migrations. Run "bun run migrate" (or start the server once) first.');
    process.exit(1);
  }
  const current = loadSecretBox(config, log);
  const next = createSecretBox(parseSecretKey(newKeyText));
  const { rotated, alreadyNew } = await rotateSecretKey(db, current, next, log);
  const total = Object.values(rotated).reduce((a, b) => a + b, 0);
  console.log(`Re-encrypted ${total} secret(s) from key ${current.fingerprint} to ${next.fingerprint}${alreadyNew ? ` (${alreadyNew} already used the new key)` : ''}:`);
  for (const [kind, n] of Object.entries(rotated)) console.log(`  ${kind}: ${n}`);
  console.log('Now start ClawRouter with the new key (CLAWROUTER_SECRET_KEY or CLAWROUTER_SECRET_KEY_FILE), then back up the database.');
} catch (error) {
  console.error(error instanceof AppError ? error.message : error);
  process.exitCode = 1;
} finally {
  db.close();
}
