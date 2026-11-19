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

import { createAuditService, createSqliteAuditRepository } from '@clawrouter/audit';
import { rotateSealedSecrets, type Logger, type SecretBox, type SecretRotation } from '@clawrouter/core';
import type { Database } from '@clawrouter/database';
import { sealedSecretStores } from './secret-stores.ts';

/**
 * Moves every stored secret (provider credentials, the mail server password,
 * authenticator-app secrets) to a new encryption key: the `rotate-secret-key`
 * command. Afterwards the server must be started with the new key; the old one
 * can be destroyed once a backup made after the rotation exists.
 */
export async function rotateSecretKey(db: Database, current: SecretBox, next: SecretBox, log?: Logger): Promise<SecretRotation> {
  const result = await rotateSealedSecrets(sealedSecretStores(db), current, next, (fn) => db.transaction(() => fn()));
  createAuditService(createSqliteAuditRepository(db), log).record({
    action: 'SECRET_KEY_ROTATED', result: 'SUCCESS', resource: 'system',
    actor: { id: null, name: 'command line' }, ip: null, requestId: null,
    // Fingerprints identify keys without revealing them.
    metadata: { from: current.fingerprint, to: next.fingerprint, rotated: result.rotated, alreadyNew: result.alreadyNew },
  });
  return result;
}
