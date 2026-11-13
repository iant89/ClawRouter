/**
 * Recovers a console account from the server's command line (spec §15: no web
 * password reset). Prints a temporary password once; the user must change it at
 * the next sign-in.
 *
 *   bun run reset-password <username>            new temporary password, sessions ended
 *   bun run reset-password <username> --enable   also re-enables a disabled account
 *
 * Uses the same configuration as the server (CLAWROUTER_DATABASE_PATH etc.).
 */
import { AppError, createLogger, loadConfig } from '@clawrouter/core';
import { migrationStatus, migrations, openSqlite } from '@clawrouter/database';
import { recoverPassword } from '../apps/server/src/recover.ts';

const args = process.argv.slice(2);
const username = args.find((a) => !a.startsWith('--'));
if (!username || args.includes('--help')) {
  console.error('usage: bun run reset-password <username> [--enable]');
  process.exit(username ? 0 : 2);
}

const config = loadConfig();
const log = createLogger({ level: 'warn', format: 'pretty' });
const db = openSqlite({ path: config.database.path });
try {
  if (migrationStatus(db, migrations).some((m) => !m.appliedAt)) {
    console.error('The database has pending migrations. Run "bun run migrate" (or start the server once) first.');
    process.exit(1);
  }
  const { user, password } = await recoverPassword(db, username, { enable: args.includes('--enable'), log });
  // Printed to this terminal only: never logged or stored in plain text.
  console.log(`Temporary password for ${user.username}: ${password}`);
  console.log('They must choose a new password when they sign in. Their sessions have been ended.');
  if (user.status !== 'ACTIVE') console.log('The account is disabled. Add --enable to re-enable it.');
} catch (error) {
  console.error(error instanceof AppError ? error.message : error);
  process.exitCode = 1;
} finally {
  db.close();
}
