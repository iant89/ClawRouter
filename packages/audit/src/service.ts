import { newId, redact, type Logger } from '@clawapi/core';
import type { AuditAction, AuditRecord, AuditResult } from '@clawapi/shared';
import type { AuditRepository } from './repository.ts';

export interface AuditEntry {
  action: AuditAction;
  result: AuditResult;
  actor?: { id: string | null; name: string | null } | null;
  resource?: string;
  resourceId?: string;
  ip?: string | null;
  requestId?: string | null;
  /** Context for investigators. Passed through `redact`, but do not put secrets here in the first place. */
  metadata?: Record<string, unknown>;
}

export interface AuditService {
  record(entry: AuditEntry): void;
  list: AuditRepository['list'];
}

/**
 * Writes audit records. Metadata is redacted before it is stored. A failing
 * write is logged at ERROR and does not fail the user's operation.
 */
export function createAuditService(repo: AuditRepository, log?: Logger, now: () => Date = () => new Date()): AuditService {
  return {
    record(entry) {
      const record: AuditRecord = {
        id: newId(),
        timestamp: now().toISOString(),
        actorId: entry.actor?.id ?? null,
        actorName: entry.actor?.name ?? null,
        action: entry.action,
        resource: entry.resource ?? null,
        resourceId: entry.resourceId ?? null,
        result: entry.result,
        ip: entry.ip ?? null,
        requestId: entry.requestId ?? null,
        metadata: entry.metadata ? (redact(entry.metadata) as Record<string, unknown>) : null,
      };
      try {
        repo.append(record);
      } catch (error) {
        log?.error('audit write failed', { component: 'audit', action: entry.action, error });
      }
    },
    list: (query) => repo.list(query),
  };
}
