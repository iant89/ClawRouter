import type { Database, SqlParams } from '@clawrouter/database';
import type { OperationInfo, OperationStatus, OperationType } from '@clawrouter/shared';

export interface OperationRow {
  id: string;
  type: OperationType;
  targetId: string | null;
  status: OperationStatus;
  progress: number;
  message: string | null;
  result: unknown;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type OperationPatch = Partial<Pick<OperationRow, 'status' | 'progress' | 'message' | 'result' | 'error' | 'startedAt' | 'completedAt'>>;

/** Storage for operations (spec §30 OPERATIONS). */
export interface OperationRepository {
  insert(op: OperationRow): void;
  update(id: string, patch: OperationPatch): void;
  get(id: string): (Omit<OperationInfo, 'targetLabel'>) | undefined;
  list(q: { types: OperationType[]; status?: OperationStatus; limit: number; offset: number }): { items: Omit<OperationInfo, 'targetLabel'>[]; total: number };
  /** QUEUED and RUNNING operations left by a previous process. */
  markInterrupted(at: string): number;
  prune(before: string): number;
}

interface Row {
  id: string;
  type: OperationType;
  target_id: string | null;
  status: OperationStatus;
  progress: number;
  message: string | null;
  result: string | null;
  error: string | null;
  created_by: string | null;
  username: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const SELECT = 'SELECT o.*, u.username FROM operations o LEFT JOIN users u ON u.id = o.created_by';

const toInfo = (r: Row): Omit<OperationInfo, 'targetLabel'> => ({
  id: r.id,
  type: r.type,
  targetId: r.target_id,
  status: r.status,
  progress: r.progress,
  message: r.message,
  result: r.result === null ? null : (JSON.parse(r.result) as unknown),
  error: r.error,
  createdBy: r.created_by ? { id: r.created_by, username: r.username ?? '(deleted user)' } : null,
  createdAt: r.created_at,
  startedAt: r.started_at,
  completedAt: r.completed_at,
});

const COLUMNS: Record<keyof OperationPatch, string> = {
  status: 'status', progress: 'progress', message: 'message', result: 'result', error: 'error', startedAt: 'started_at', completedAt: 'completed_at',
};

export function createSqliteOperationRepository(db: Database): OperationRepository {
  return {
    insert(op) {
      db.run(
        `INSERT INTO operations (id, type, target_id, status, progress, message, result, error, created_by, created_at, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [op.id, op.type, op.targetId, op.status, op.progress, op.message, op.result === null || op.result === undefined ? null : JSON.stringify(op.result),
          op.error, op.createdBy, op.createdAt, op.startedAt, op.completedAt],
      );
    },
    update(id, patch) {
      const keys = Object.keys(patch) as (keyof OperationPatch)[];
      if (!keys.length) return;
      const values = keys.map((k) => (k === 'result' ? (patch.result === null || patch.result === undefined ? null : JSON.stringify(patch.result)) : patch[k]));
      db.run(`UPDATE operations SET ${keys.map((k) => `${COLUMNS[k]} = ?`).join(', ')} WHERE id = ?`, [...values, id] as SqlParams);
    },
    get(id) {
      const r = db.get<Row>(`${SELECT} WHERE o.id = ?`, [id]);
      return r ? toInfo(r) : undefined;
    },
    list(q) {
      if (!q.types.length) return { items: [], total: 0 };
      const where = [`o.type IN (${q.types.map(() => '?').join(', ')})`];
      const params: string[] = [...q.types];
      if (q.status) {
        where.push('o.status = ?');
        params.push(q.status);
      }
      const sql = `WHERE ${where.join(' AND ')}`;
      const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM operations o ${sql}`, params)?.n ?? 0;
      const items = db.all<Row>(`${SELECT} ${sql} ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`, [...params, q.limit, q.offset] as SqlParams).map(toInfo);
      return { items, total };
    },
    markInterrupted(at) {
      return db.run(
        `UPDATE operations SET status = 'FAILED', completed_at = ?, error = 'The server stopped before this operation finished.'
         WHERE status IN ('QUEUED', 'RUNNING')`,
        [at],
      ).changes;
    },
    prune: (before) => db.run(`DELETE FROM operations WHERE created_at < ? AND status NOT IN ('QUEUED', 'RUNNING')`, [before]).changes,
  };
}
