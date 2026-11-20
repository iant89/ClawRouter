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

import type { AuditAction, AuditRecord, AuditSearch } from '@clawrouter/shared';
import type { Database } from '@clawrouter/database';

export interface AuditQuery {
  action?: AuditAction;
  actorId?: string;
  limit?: number;
  /** Return records strictly older than this timestamp (keyset pagination). */
  before?: string;
}

/** Append-only: there is deliberately no update or delete. */
export interface AuditRepository {
  append(record: AuditRecord): void;
  list(query?: AuditQuery): AuditRecord[];
  /** Filtered, paged search for the Audit page, newest first. */
  search(query: AuditSearch & { limit: number; offset: number }): { items: AuditRecord[]; total: number };
  /** Resource types that occur in the log, for the filter. */
  resources(): string[];
}

interface Row {
  id: string;
  timestamp: string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  resource: string | null;
  resource_id: string | null;
  result: string;
  ip: string | null;
  request_id: string | null;
  metadata: string | null;
}

const toRecord = (r: Row): AuditRecord => ({
  id: r.id,
  timestamp: r.timestamp,
  actorId: r.actor_id,
  actorName: r.actor_name,
  action: r.action as AuditAction,
  resource: r.resource,
  resourceId: r.resource_id,
  result: r.result as AuditRecord['result'],
  ip: r.ip,
  requestId: r.request_id,
  metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
});

export function createSqliteAuditRepository(db: Database): AuditRepository {
  return {
    append(rec) {
      db.run(
        `INSERT INTO audit_log (id, timestamp, actor_id, actor_name, action, resource, resource_id, result, ip, request_id, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [rec.id, rec.timestamp, rec.actorId, rec.actorName, rec.action, rec.resource, rec.resourceId, rec.result, rec.ip, rec.requestId,
          rec.metadata ? JSON.stringify(rec.metadata) : null],
      );
    },
    list(query = {}) {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (query.action) { where.push('action = ?'); params.push(query.action); }
      if (query.actorId) { where.push('actor_id = ?'); params.push(query.actorId); }
      if (query.before) { where.push('timestamp < ?'); params.push(query.before); }
      params.push(Math.min(Math.max(query.limit ?? 50, 1), 500));
      return db
        .all<Row>(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY timestamp DESC, id DESC LIMIT ?`, params)
        .map(toRecord);
    },
    search(q) {
      const where: string[] = [];
      const params: (string | number)[] = [];
      const add = (sql: string, ...values: (string | number)[]) => {
        where.push(sql);
        params.push(...values);
      };
      if (q.action) add('action = ?', q.action);
      if (q.result) add('result = ?', q.result);
      if (q.resource) add('resource = ?', q.resource);
      if (q.resourceId) add('resource_id = ?', q.resourceId);
      if (q.requestId) add('request_id = ?', q.requestId);
      if (q.actor) add("actor_name LIKE ? ESCAPE '\\'", `%${escapeLike(q.actor)}%`);
      if (q.from) add('timestamp >= ?', q.from);
      if (q.to) add('timestamp < ?', q.to);
      // Free text of 3+ characters uses the trigram index (audit_fts, migration 0017):
      // the same case-insensitive substring match as LIKE, without reading every row.
      // (Actor names repeat across many records, so the actor filter scans instead.)
      // NUL characters are dropped: FTS5 refuses a query holding one ("unterminated string", a 500
      // found by fuzzing, SEC-021) and LIKE stops reading the pattern there.
      const text = q.q?.replace(/\u0000/g, '');
      if (text && [...text].length >= 3) add(`rowid IN (SELECT rowid FROM audit_fts WHERE audit_fts MATCH ?)`, ftsPhrase(text));
      else if (text) {
        const like = `%${escapeLike(text)}%`;
        add("(actor_name LIKE ? ESCAPE '\\' OR resource_id LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\' OR request_id LIKE ? ESCAPE '\\' OR metadata LIKE ? ESCAPE '\\')", like, like, like, like, like);
      }
      const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log ${sql}`, params)?.n ?? 0;
      const items = db.all<Row>(`SELECT * FROM audit_log ${sql} ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`, [...params, q.limit, q.offset]).map(toRecord);
      return { items, total };
    },
    resources() {
      return db.all<{ resource: string }>('SELECT DISTINCT resource FROM audit_log WHERE resource IS NOT NULL ORDER BY resource').map((r) => r.resource);
    },
  };
}

/** Makes user text literal inside LIKE (no wildcards from the browser). */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The text as one literal FTS5 phrase (quotes doubled): a substring match with the trigram tokenizer. */
function ftsPhrase(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}
