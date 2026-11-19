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

import { newId, redact, type Logger } from '@clawrouter/core';
import type { AuditAction, AuditRecord, AuditResult, AuditSearch } from '@clawrouter/shared';
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
  /** The Audit page: filtered and paged on the server. */
  search(query: AuditSearch): { items: AuditRecord[]; total: number; page: number; pageSize: number; resources: string[] };
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
    search(query) {
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 50;
      return { ...repo.search({ ...query, limit: pageSize, offset: (page - 1) * pageSize }), page, pageSize, resources: repo.resources() };
    },
  };
}
