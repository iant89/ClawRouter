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
