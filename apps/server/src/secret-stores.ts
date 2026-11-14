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
