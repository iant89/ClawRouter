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
