/**
 * Credential recovery when the secret key is lost (or was replaced without
 * rotating): lists the stored values the configured key cannot open and, with
 * --yes, forgets them so they can be entered again. Values that still open are kept.
 *
 *   bun run clear-credentials          show what cannot be opened
 *   bun run clear-credentials --yes    forget those values
 *
 * If the old key still exists somewhere, configure it instead: nothing is lost then.
 */
import { AppError, createLogger, loadConfig } from '@clawrouter/core';
import { openSqlite } from '@clawrouter/database';
import { clearUnreadable, findUnreadable } from '../apps/server/src/clear-credentials.ts';
import { loadSecretBox } from '../apps/server/src/secret-key.ts';

const config = loadConfig();
const log = createLogger({ level: 'warn', format: 'pretty' });
const db = openSqlite({ path: config.database.path });
try {
  const box = loadSecretBox(config, log);
  const yes = process.argv.includes('--yes');
  const list = yes ? await clearUnreadable(db, box, log) : await findUnreadable(db, box);
  if (!list.length) console.log(`Every stored value opens with the configured key (${box.fingerprint}). Nothing to do.`);
  else {
    console.log(`${list.length} stored value(s) cannot be opened with the configured key (${box.fingerprint})${yes ? ' and were forgotten' : ''}:`);
    for (const s of list) console.log(`  ${s.label} (${s.store}): ${s.consequence}`);
    if (!yes) console.log('\nIf the old key still exists, configure it instead. Otherwise run again with --yes, then enter those values again.');
  }
} catch (error) {
  console.error(error instanceof AppError ? error.message : error);
  process.exitCode = 1;
} finally {
  db.close();
}
