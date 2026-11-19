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
 * Checks a ClawRouter deployment (configuration, secret key, database, migrations,
 * encrypted values, HTTPS, backups, disk) and, with --fix, repairs what it safely can.
 *
 *   bun run doctor                          check only; changes nothing
 *   bun run doctor --json                   the same, for monitoring
 *   bun run doctor --fix                    list the repairs, ask, apply them, check again
 *   bun run doctor --fix --yes              without asking (scripts, cron)
 *   bun run doctor --fix --clear-unreadable also forget encrypted values the key cannot
 *                                           open (after a backup; they must be entered again)
 *
 * Repairs: remove a stale process-ID file, make the key file owner-only, take a
 * backup when there is none or it is overdue, apply pending migrations (server
 * stopped; backup first). Settings that live in the environment are never changed.
 * Exits with 1 when something is still wrong (✖) or a repair failed, 0 otherwise.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { AppError, createLogger, loadConfig, type Config, type SecretBox } from '@clawrouter/core';
import { applyRepairs, plannedRepairs, runDoctor, type DoctorCheck, type RepairResult } from '../apps/server/src/doctor.ts';
import { loadSecretBox } from '../apps/server/src/secret-key.ts';
import { VERSION } from '../apps/server/src/version.ts';

const args = new Set(process.argv.slice(2));
const json = args.has('--json');
const fix = args.has('--fix');
const yes = args.has('--yes');
const includeDestructive = args.has('--clear-unreadable');

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  console.error(`✖ configuration: ${error instanceof AppError ? error.message : error}`);
  process.exit(1);
}

function loadKey(): { box: SecretBox | null; keyError: string | null } {
  // In development the key file is generated at first start: do not create it here.
  const devKey = join(dirname(resolve(config.database.path)), 'secret.key');
  if (!config.secrets.key && !config.secrets.keyFile && config.database.path !== ':memory:' && !existsSync(devKey)) {
    return { box: null, keyError: 'none yet (a development key is generated at first start)' };
  }
  try {
    return { box: loadSecretBox(config, createLogger({ level: 'error', format: 'pretty' })), keyError: null };
  } catch (error) {
    return { box: null, keyError: error instanceof Error ? error.message : String(error) };
  }
}

const mark = { ok: '✔', warn: '!', error: '✖', info: '·' } as const;
function print(checks: DoctorCheck[]) {
  for (const c of checks) {
    console.log(`${mark[c.level]} ${c.area}: ${c.message}`);
    if (c.fix) console.log(`    → ${c.fix}`);
  }
  const errors = checks.filter((c) => c.level === 'error').length;
  const warnings = checks.filter((c) => c.level === 'warn').length;
  console.log(`\n${errors ? `${errors} problem(s)` : 'No problems'}${warnings ? `, ${warnings} warning(s)` : ''}.`);
}

const { box, keyError } = loadKey();
const before = await runDoctor(config, box, keyError);

if (!fix) {
  if (json) console.log(JSON.stringify(before, null, 2));
  else {
    print(before);
    const n = plannedRepairs(before, { includeDestructive: true }).length;
    if (n) console.log(`${n} of these can be repaired: run "bun run doctor --fix".`);
  }
  process.exit(before.some((c) => c.level === 'error') ? 1 : 0);
}

const plan = plannedRepairs(before, { includeDestructive });
const held = plannedRepairs(before, { includeDestructive: true }).filter((r) => r.destructive && !includeDestructive);
if (!json) {
  print(before);
  console.log(plan.length ? '\nRepairs:' : '\nNothing to repair automatically.');
  plan.forEach((r, i) => console.log(`  ${i + 1}. ${r.action}${r.destructive ? '  [loses data]' : ''}`));
  for (const r of held) console.log(`  Not included: ${r.action} Add --clear-unreadable to include it.`);
}

let results: RepairResult[] = [];
if (plan.length) {
  let go = yes;
  if (!go && process.stdin.isTTY && !json) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    go = /^y(es)?$/i.test((await rl.question('\nApply these repairs? [y/N] ')).trim());
    rl.close();
  } else if (!go) {
    if (!json) console.log('\nNo changes made: add --yes to apply the repairs without asking.');
  }
  if (go) {
    results = await applyRepairs(config, box, plan, { version: VERSION, log: createLogger({ level: 'error', format: 'pretty' }) });
    if (!json) {
      console.log('');
      for (const r of results) console.log(`${r.ok ? '✔' : '✖'} ${r.message}`);
    }
  }
}

// Check again after repairs so the summary reflects the state now.
const reloaded = results.length ? loadKey() : null;
const after = reloaded ? await runDoctor(config, reloaded.box, reloaded.keyError) : before;
if (json) console.log(JSON.stringify({ before, repairs: results, after }, null, 2));
else if (results.length) {
  console.log('\nAfter the repairs:');
  print(after);
}
process.exit(after.some((c) => c.level === 'error') || results.some((r) => !r.ok) ? 1 : 0);
