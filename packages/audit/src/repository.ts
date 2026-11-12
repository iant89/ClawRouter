import type { AuditAction, AuditRecord } from '@clawapi/shared';
import type { Database } from '@clawapi/database';

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
  };
}
