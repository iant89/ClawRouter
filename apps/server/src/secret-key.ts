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

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createSecretBox, generateSecretKey, parseSecretKey, tightenMode, type Config, type Logger, type SecretBox } from '@clawrouter/core';

/**
 * Loads the key that encrypts stored credentials (spec §29: external to the
 * database). Order: CLAWROUTER_SECRET_KEY, CLAWROUTER_SECRET_KEY_FILE, then, outside
 * production only, a generated `secret.key` next to the database (mode 0600).
 * Production refuses to start without an explicit key (enforced by config).
 */
export function loadSecretBox(config: Config, log: Logger): SecretBox {
  let text: string;
  if (config.secrets.key) {
    text = config.secrets.key;
  } else if (config.secrets.keyFile) {
    text = readFileSync(config.secrets.keyFile, 'utf8');
  } else if (config.database.path === ':memory:') {
    text = generateSecretKey();
    log.warn('using a temporary secret key: stored credentials will not survive a restart', { component: 'secrets' });
  } else {
    const file = join(dirname(resolve(config.database.path)), 'secret.key');
    if (!existsSync(file)) {
      writeFileSync(file, `${generateSecretKey()}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
      log.warn('generated a development secret key; back it up, or credentials cannot be decrypted. Set CLAWROUTER_SECRET_KEY in production', { component: 'secrets', file });
    } else if (tightenMode(file)) {
      // SEC-023: the generated key is ClawRouter's own file; an operator's CLAWROUTER_SECRET_KEY_FILE is only reported (doctor).
      log.warn('the secret key file was readable by other accounts; made private (0600)', { component: 'secrets', file });
    }
    text = readFileSync(file, 'utf8');
  }
  const box = createSecretBox(parseSecretKey(text));
  log.info('secret key loaded', { component: 'secrets', fingerprint: box.fingerprint });
  return box;
}
