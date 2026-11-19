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

import { createSqliteTwoFactorRepository, totpSecrets } from '@clawrouter/authentication';
import type { SealedSecretStore } from '@clawrouter/core';
import { createSqliteSettingsRepository, type Database } from '@clawrouter/database';
import { mailPasswordSecrets } from '@clawrouter/mail';
import { createSqliteProviderRepository, providerCredentialSecrets } from '@clawrouter/providers';

/**
 * Every value in the database encrypted with the secret key (phase 17). Key
 * rotation, `doctor`, restore checks and `clear-credentials` use this list, so a
 * new kind of encrypted value must be added here.
 */
export function sealedSecretStores(db: Database): SealedSecretStore[] {
  const providers = createSqliteProviderRepository(db);
  const names = new Map(db.all<{ id: string; identifier: string }>('SELECT id, identifier FROM providers').map((p) => [p.id, p.identifier]));
  return [
    providerCredentialSecrets(providers, (id) => names.get(id) ?? id),
    mailPasswordSecrets(createSqliteSettingsRepository(db)),
    totpSecrets(createSqliteTwoFactorRepository(db)),
  ];
}
