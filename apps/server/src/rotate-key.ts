import { createAuditService, createSqliteAuditRepository } from '@clawrouter/audit';
import type { Logger, SecretBox } from '@clawrouter/core';
import type { Database } from '@clawrouter/database';
import { createSqliteProviderRepository, rotateCredentialKey, type RotationResult } from '@clawrouter/providers';

/**
 * Moves stored provider credentials to a new encryption key (the
 * `rotate-secret-key` command). Afterwards the server must be started with the
 * new key; the old one can be destroyed once a backup made after the rotation exists.
 */
export async function rotateSecretKey(db: Database, current: SecretBox, next: SecretBox, log?: Logger): Promise<RotationResult> {
  const result = await rotateCredentialKey(createSqliteProviderRepository(db), current, next);
  createAuditService(createSqliteAuditRepository(db), log).record({
    action: 'SECRET_KEY_ROTATED', result: 'SUCCESS', resource: 'system',
    actor: { id: null, name: 'command line' }, ip: null, requestId: null,
    // Fingerprints identify keys without revealing them.
    metadata: { from: current.fingerprint, to: next.fingerprint, rotated: result.rotated, alreadyNew: result.alreadyNew },
  });
  return result;
}
