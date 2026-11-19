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
import { checkSealedSecrets, type Logger, type SecretBox } from '@clawrouter/core';
import type { Database } from '@clawrouter/database';
import { sealedSecretStores } from './secret-stores.ts';

export interface UnreadableSecret {
  store: string;
  label: string;
  /** What forgetting it means for the operator. */
  consequence: string;
}

/** Encrypted values the configured key cannot open (a lost or replaced key). */
export async function findUnreadable(db: Database, box: SecretBox): Promise<UnreadableSecret[]> {
  const stores = sealedSecretStores(db);
  const checks = await checkSealedSecrets(stores, box);
  return checks.filter((c) => !c.ok).map((c) => ({ store: c.store, label: c.secret.label, consequence: stores.find((s) => s.name === c.store)!.whenForgotten }));
}

/**
 * Credential recovery for a lost secret key (phase 17): forgets every encrypted
 * value the configured key cannot open, so ClawRouter works again with the new key
 * and those values can be entered again. Values that still open are kept.
 */
export async function clearUnreadable(db: Database, box: SecretBox, log?: Logger): Promise<UnreadableSecret[]> {
  const stores = sealedSecretStores(db);
  const bad = (await checkSealedSecrets(stores, box)).filter((c) => !c.ok);
  db.transaction(() => {
    for (const c of bad) stores.find((s) => s.name === c.store)!.forget(c.secret.id);
  });
  const cleared = bad.map((c) => ({ store: c.store, label: c.secret.label, consequence: stores.find((s) => s.name === c.store)!.whenForgotten }));
  if (cleared.length) {
    createAuditService(createSqliteAuditRepository(db), log).record({
      action: 'CREDENTIALS_CLEARED', result: 'SUCCESS', resource: 'system', actor: { id: null, name: 'command line' }, ip: null, requestId: null,
      metadata: { keyFingerprint: box.fingerprint, cleared: cleared.map((c) => `${c.store}: ${c.label}`) },
    });
  }
  return cleared;
}
