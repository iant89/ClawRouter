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
 * Recovers a console account from the server's command line (spec §15: no web
 * password reset). Prints a temporary password once; the user must change it at
 * the next sign-in.
 *
 *   bun run reset-password <username>            new temporary password, sessions ended
 *   bun run reset-password <username> --enable   also re-enables a disabled account
 *   bun run reset-password <username> --reset-2fa also removes two-factor sign-in (lost phone)
 *
 * Uses the same configuration as the server (CLAWROUTER_DATABASE_PATH etc.).
 */
import { AppError, createLogger, loadConfig } from '@clawrouter/core';
import { migrationStatus, migrations, openSqlite } from '@clawrouter/database';
import { recoverPassword } from '../apps/server/src/recover.ts';

const args = process.argv.slice(2);
const username = args.find((a) => !a.startsWith('--'));
if (!username || args.includes('--help')) {
  console.error('usage: bun run reset-password <username> [--enable] [--reset-2fa]');
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
  const { user, password } = await recoverPassword(db, username, { enable: args.includes('--enable'), resetTwoFactor: args.includes('--reset-2fa'), log });
  // Printed to this terminal only: never logged or stored in plain text.
  console.log(`Temporary password for ${user.username}: ${password}`);
  console.log('They must choose a new password when they sign in. Their sessions have been ended.');
  if (user.status !== 'ACTIVE') console.log('The account is disabled. Add --enable to re-enable it.');
  if (user.twoFactor.length) console.log('Two-factor sign-in is still on (' + user.twoFactor.join(', ') + '). Add --reset-2fa if the phone or mailbox is lost too.');
} catch (error) {
  console.error(error instanceof AppError ? error.message : error);
  process.exitCode = 1;
} finally {
  db.close();
}
