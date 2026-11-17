import type { Database } from '@clawrouter/database';
import type { CaptureDetail, CaptureSummary, CaptureTrigger, GatewayEndpoint } from '@clawrouter/shared';

export interface CaptureQuery {
  trigger?: CaptureTrigger;
  providerId?: string;
  limit: number;
  offset: number;
}

export interface CaptureRepository {
  insert(capture: CaptureDetail): void;
  list(q: CaptureQuery): { items: CaptureSummary[]; total: number };
  get(id: string): CaptureDetail | undefined;
  /** Ids that exist, in the order given. */
  existing(ids: string[]): string[];
  delete(ids: string[]): number;
  deleteAll(): number;
  count(): number;
  /** Deletes the oldest beyond `keep`; returns how many. */
  trim(keep: number): number;
}

interface Row {
  id: string;
  created_at: string;
  trigger: CaptureTrigger;
  request_id: string;
  endpoint: GatewayEndpoint;
  stream: number;
  requested_model: string;
  model_ref: string | null;
  provider_id: string | null;
  provider_name: string | null;
  status: string;
  http_status: number;
  error_code: string | null;
  error_message: string | null;
  exchange_count: number;
  size_bytes: number;
}

const SUMMARY_COLUMNS = `id, created_at, trigger, request_id, endpoint, stream, requested_model, model_ref, provider_id, provider_name,
  status, http_status, error_code, error_message, exchange_count, size_bytes`;

function summary(r: Row): CaptureSummary {
  return {
    id: r.id, createdAt: r.created_at, trigger: r.trigger, requestId: r.request_id, endpoint: r.endpoint, stream: r.stream === 1,
    requestedModel: r.requested_model, modelRef: r.model_ref, providerId: r.provider_id, providerName: r.provider_name,
    outcome: { status: r.status, httpStatus: r.http_status, errorCode: r.error_code, errorMessage: r.error_message },
    exchangeCount: r.exchange_count, sizeBytes: r.size_bytes,
  };
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

export function createSqliteCaptureRepository(db: Database): CaptureRepository {
  return {
    insert(c) {
      const data = JSON.stringify({ client: c.client, attempts: c.attempts, exchanges: c.exchanges });
      db.run(
        `INSERT INTO provider_captures (${SUMMARY_COLUMNS}, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [c.id, c.createdAt, c.trigger, c.requestId, c.endpoint, c.stream ? 1 : 0, c.requestedModel, c.modelRef, c.providerId, c.providerName,
          c.outcome.status, c.outcome.httpStatus, c.outcome.errorCode, c.outcome.errorMessage, c.exchangeCount, c.sizeBytes, data],
      );
    },
    list({ trigger, providerId, limit, offset }) {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (trigger) {
        where.push('trigger = ?');
        params.push(trigger);
      }
      if (providerId) {
        where.push('provider_id = ?');
        params.push(providerId);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM provider_captures ${clause}`, params)?.n ?? 0;
      const rows = db.all<Row>(`SELECT ${SUMMARY_COLUMNS} FROM provider_captures ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
      return { items: rows.map(summary), total };
    },
    get(id) {
      const row = db.get<Row & { data: string }>(`SELECT ${SUMMARY_COLUMNS}, data FROM provider_captures WHERE id = ?`, [id]);
      if (!row) return undefined;
      const data = JSON.parse(row.data) as Pick<CaptureDetail, 'client' | 'attempts' | 'exchanges'>;
      return { ...summary(row), ...data };
    },
    existing(ids) {
      if (!ids.length) return [];
      const found = new Set(db.all<{ id: string }>(`SELECT id FROM provider_captures WHERE id IN (${placeholders(ids.length)})`, ids).map((r) => r.id));
      return ids.filter((id) => found.has(id));
    },
    delete(ids) {
      if (!ids.length) return 0;
      return db.run(`DELETE FROM provider_captures WHERE id IN (${placeholders(ids.length)})`, ids).changes;
    },
    deleteAll() {
      return db.run('DELETE FROM provider_captures').changes;
    },
    count() {
      return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM provider_captures')?.n ?? 0;
    },
    trim(keep) {
      return db.run(
        `DELETE FROM provider_captures WHERE id IN (
           SELECT id FROM provider_captures ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?
         )`,
        [keep],
      ).changes;
    },
  };
}
