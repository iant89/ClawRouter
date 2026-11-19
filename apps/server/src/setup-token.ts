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

import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { generateToken } from '@clawrouter/authentication';
import type { Config, Logger } from '@clawrouter/core';

export interface SetupToken {
  value: string;
  /** Where the token was written, if anywhere. */
  file: string | null;
  /** Removes the token file once setup is done. */
  discard(): void;
}

/**
 * Provides the one-time initial-setup token. The token is a secret, so it is
 * never logged: it is either chosen by the operator (CLAWROUTER_SETUP_TOKEN) or
 * generated and written to `setup-token` next to the database (mode 0600),
 * and only the file path is logged.
 */
export function provisionSetupToken(config: Config, log: Logger): SetupToken {
  if (config.auth.setupToken) {
    log.warn('initial setup required: use the token from CLAWROUTER_SETUP_TOKEN at /setup', { component: 'setup' });
    return { value: config.auth.setupToken, file: null, discard() {} };
  }

  const value = generateToken(24);
  if (config.database.path === ':memory:') {
    log.warn('initial setup required, but the database is in memory: set CLAWROUTER_SETUP_TOKEN to complete setup', { component: 'setup' });
    return { value, file: null, discard() {} };
  }

  const file = join(dirname(resolve(config.database.path)), 'setup-token');
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  log.warn('initial setup required: open the console at /setup and enter the token from this file', { component: 'setup', file });
  return {
    value,
    file,
    discard() {
      if (existsSync(file)) rmSync(file, { force: true });
    },
  };
}
