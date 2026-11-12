import type { Database, SqlParams } from '@clawrouter/database';
import type {
  GatewayEndpoint, RequestAttempt, RequestDetail, RequestQuery, RequestRecord, RequestStatus, UsageBreakdownRow, UsageGroup, UsageSource,
  UsageTotals,
} from '@clawrouter/shared';

/** A new request, written when it is received. */
export interface NewRequest {
  id: string;
  receivedAt: string;
  status: RequestStatus;
  endpoint: GatewayEndpoint;
  stream: boolean;
  apiKeyId: string;
  userId: string | null;
  requestedModel: string;
}

/** How a request ended. */
export interface RequestOutcome {
  completedAt: string;
  status: RequestStatus;
  httpStatus: number;
  modelRef: string | null;
  providerId: string | null;
  durationMs: number;
  attempts: number;
  retries: number;
  failovers: number;
  attemptLog: RequestAttempt[];
  errorCode: string | null;
  errorMessage: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  usageSource: UsageSource;
  costUsd: number | null;
}

/** One request's contribution to the hourly usage records. */
export interface UsageIncrement {
  hour: string;
  apiKeyId: string;
  userId: string | null;
  modelRef: string;
  providerId: string;
  error: boolean;
  inputTokens: number;
  outputTokens: number;
  estimatedTokens: number;
  costUsd: number;
  unpriced: boolean;
  durationMs: number;
}

export interface UsageQuery {
  from: string;
  to: string;
  bucket: 'hour' | 'day';
  groupBy: UsageGroup;
}

/** Request history and usage storage (spec §30 REQUESTS, USAGE_RECORDS). */
export interface RequestRepository {
  insert(r: NewRequest): void;
  setStatus(id: string, status: RequestStatus): void;
  finish(id: string, outcome: RequestOutcome): void;
  addUsage(u: UsageIncrement): void;
  get(id: string): RequestDetail | undefined;
  list(q: RequestQuery & { limit: number; offset: number }): { items: RequestRecord[]; total: number };
  usageTotals(from: string, to: string): UsageTotals;
  usageSeries(q: UsageQuery): (UsageTotals & { start: string })[];
  usageBreakdown(q: UsageQuery): UsageBreakdownRow[];
  /** Deletes request rows received before `before`. Returns how many. */
  pruneRequests(before: string): number;
  /** Deletes usage records for hours before `before`. */
  pruneUsage(before: string): number;
  /** Requests still in progress (after a crash or restart): marks them failed. */
  markInterrupted(at: string): number;
}

interface Row {
  id: string;
  received_at: string;
  completed_at: string | null;
  status: RequestStatus;
  endpoint: GatewayEndpoint;
  stream: number;
  api_key_id: string | null;
  key_name: string | null;
  key_prefix: string | null;
  user_id: string | null;
  username: string | null;
  requested_model: string;
  model_ref: string | null;
  provider_id: string | null;
  provider_name: string | null;
  duration_ms: number | null;
  http_status: number | null;
  attempts: number;
  retries: number;
  failovers: number;
  attempt_log: string;
  error_code: string | null;
  error_message: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  usage_source: UsageSource;
  cost_usd: number | null;
}

const SELECT = `
SELECT r.*, k.name AS key_name, k.prefix AS key_prefix, u.username, p.name AS provider_name
FROM requests r
LEFT JOIN api_keys k ON k.id = r.api_key_id
LEFT JOIN users u ON u.id = r.user_id
LEFT JOIN providers p ON p.id = r.provider_id`;

const toRecord = (r: Row): RequestRecord => ({
  id: r.id,
  receivedAt: r.received_at,
  completedAt: r.completed_at,
  status: r.status,
  endpoint: r.endpoint,
  stream: r.stream === 1,
  apiKey: r.api_key_id ? { id: r.api_key_id, name: r.key_name ?? '(deleted key)', prefix: r.key_prefix ?? '' } : null,
  user: r.user_id ? { id: r.user_id, username: r.username ?? '(deleted user)' } : null,
  requestedModel: r.requested_model,
  modelRef: r.model_ref,
  provider: r.provider_id ? { id: r.provider_id, name: r.provider_name ?? '(deleted provider)' } : null,
  durationMs: r.duration_ms,
  httpStatus: r.http_status,
  attempts: r.attempts,
  retries: r.retries,
  failovers: r.failovers,
  errorCode: r.error_code,
  errorMessage: r.error_message,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  usageSource: r.usage_source,
  costUsd: r.cost_usd,
});

const TOTALS = `
  COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(errors), 0) AS errors,
  COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(estimated_tokens), 0) AS estimated_tokens, COALESCE(SUM(cost_usd), 0) AS cost_usd,
  COALESCE(SUM(unpriced_requests), 0) AS unpriced_requests, COALESCE(SUM(duration_ms), 0) AS duration_ms`;

interface TotalsRow {
  requests: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  estimated_tokens: number;
  cost_usd: number;
  unpriced_requests: number;
  duration_ms: number;
}

const toTotals = (t: TotalsRow): UsageTotals => ({
  requests: t.requests,
  errors: t.errors,
  inputTokens: t.input_tokens,
  outputTokens: t.output_tokens,
  estimatedTokens: t.estimated_tokens,
  // Sums of floats: round to a tenth of a cent's hundredth to avoid 0.30000000000000004.
  costUsd: Math.round(t.cost_usd * 1e6) / 1e6,
  unpricedRequests: t.unpriced_requests,
  averageDurationMs: t.requests ? Math.round(t.duration_ms / t.requests) : null,
});

/** SQL expressions per breakdown: the grouping key and its display label. */
const GROUP: Record<UsageGroup, { key: string; label: string; join: string }> = {
  model: { key: 'ur.model_ref', label: "CASE ur.model_ref WHEN '' THEN '(not routed)' ELSE ur.model_ref END", join: '' },
  provider: { key: 'ur.provider_id', label: "CASE ur.provider_id WHEN '' THEN '(not routed)' ELSE COALESCE(p.name, '(deleted provider)') END", join: 'LEFT JOIN providers p ON p.id = ur.provider_id' },
  apiKey: { key: 'ur.api_key_id', label: "COALESCE(k.name || ' (' || k.prefix || '…)', '(deleted key)')", join: 'LEFT JOIN api_keys k ON k.id = ur.api_key_id' },
  user: { key: "COALESCE(ur.user_id, '')", label: "CASE WHEN ur.user_id IS NULL THEN '(no owner)' ELSE COALESCE(u.username, '(deleted user)') END", join: 'LEFT JOIN users u ON u.id = ur.user_id' },
};

export function createSqliteRequestRepository(db: Database): RequestRepository {
  function where(q: RequestQuery): { sql: string; params: SqlParams } {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (q.status) {
      clauses.push('r.status = ?');
      params.push(q.status);
    }
    if (q.problemsOnly) clauses.push("r.status IN ('FAILED', 'CANCELLED', 'TIMEOUT')");
    if (q.apiKeyId) {
      clauses.push('r.api_key_id = ?');
      params.push(q.apiKeyId);
    }
    if (q.providerId) {
      clauses.push('r.provider_id = ?');
      params.push(q.providerId);
    }
    if (q.model) {
      clauses.push('(r.requested_model = ? COLLATE NOCASE OR r.model_ref = ? COLLATE NOCASE)');
      params.push(q.model, q.model);
    }
    if (q.from) {
      clauses.push('r.received_at >= ?');
      params.push(q.from);
    }
    if (q.to) {
      clauses.push('r.received_at < ?');
      params.push(q.to);
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  return {
    insert(r) {
      db.run(
        `INSERT INTO requests (id, received_at, status, endpoint, stream, api_key_id, user_id, requested_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.id, r.receivedAt, r.status, r.endpoint, r.stream ? 1 : 0, r.apiKeyId, r.userId, r.requestedModel],
      );
    },

    setStatus(id, status) {
      db.run('UPDATE requests SET status = ? WHERE id = ?', [status, id]);
    },

    finish(id, o) {
      db.run(
        `UPDATE requests SET completed_at = ?, status = ?, http_status = ?, model_ref = ?, provider_id = ?, duration_ms = ?,
           attempts = ?, retries = ?, failovers = ?, attempt_log = ?, error_code = ?, error_message = ?,
           input_tokens = ?, output_tokens = ?, usage_source = ?, cost_usd = ?
         WHERE id = ?`,
        [o.completedAt, o.status, o.httpStatus, o.modelRef, o.providerId, o.durationMs, o.attempts, o.retries, o.failovers,
          JSON.stringify(o.attemptLog), o.errorCode, o.errorMessage, o.inputTokens, o.outputTokens, o.usageSource, o.costUsd, id],
      );
    },

    addUsage(u) {
      db.run(
        `INSERT INTO usage_records (hour, api_key_id, user_id, model_ref, provider_id, requests, errors, input_tokens, output_tokens,
           estimated_tokens, cost_usd, unpriced_requests, duration_ms)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(hour, api_key_id, model_ref, provider_id) DO UPDATE SET
           requests = requests + 1, errors = errors + excluded.errors,
           input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens,
           estimated_tokens = estimated_tokens + excluded.estimated_tokens, cost_usd = cost_usd + excluded.cost_usd,
           unpriced_requests = unpriced_requests + excluded.unpriced_requests, duration_ms = duration_ms + excluded.duration_ms,
           user_id = excluded.user_id`,
        [u.hour, u.apiKeyId, u.userId, u.modelRef, u.providerId, u.error ? 1 : 0, u.inputTokens, u.outputTokens, u.estimatedTokens,
          u.costUsd, u.unpriced ? 1 : 0, u.durationMs],
      );
    },

    get(id) {
      const row = db.get<Row>(`${SELECT} WHERE r.id = ?`, [id]);
      return row ? { ...toRecord(row), attemptLog: JSON.parse(row.attempt_log) as RequestAttempt[] } : undefined;
    },

    list(q) {
      const w = where(q);
      const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM requests r ${w.sql}`, w.params)?.n ?? 0;
      const items = db.all<Row>(`${SELECT} ${w.sql} ORDER BY r.received_at DESC, r.id DESC LIMIT ? OFFSET ?`, [...(w.params as unknown[]), q.limit, q.offset] as SqlParams).map(toRecord);
      return { items, total };
    },

    usageTotals(from, to) {
      return toTotals(db.get<TotalsRow>(`SELECT ${TOTALS} FROM usage_records WHERE hour >= ? AND hour < ?`, [from, to])!);
    },

    usageSeries(q) {
      // Hours are stored as ISO strings ("2026-11-12T08:00:00.000Z"): a prefix is the bucket.
      const len = q.bucket === 'hour' ? 13 : 10;
      return db.all<TotalsRow & { b: string }>(
        `SELECT substr(hour, 1, ${len}) AS b, ${TOTALS} FROM usage_records WHERE hour >= ? AND hour < ? GROUP BY b ORDER BY b`,
        [q.from, q.to],
      ).map((r) => ({ ...toTotals(r), start: q.bucket === 'hour' ? `${r.b}:00:00.000Z` : `${r.b}T00:00:00.000Z` }));
    },

    usageBreakdown(q) {
      const g = GROUP[q.groupBy];
      return db.all<TotalsRow & { k: string; label: string }>(
        `SELECT ${g.key} AS k, ${g.label} AS label, ${TOTALS.replaceAll('SUM(', 'SUM(ur.')}
         FROM usage_records ur ${g.join} WHERE ur.hour >= ? AND ur.hour < ? GROUP BY k ORDER BY SUM(ur.requests) DESC LIMIT 200`,
        [q.from, q.to],
      ).map((r) => ({ ...toTotals(r), key: r.k, label: r.label }));
    },

    pruneRequests(before) {
      return db.run('DELETE FROM requests WHERE received_at < ?', [before]).changes;
    },

    pruneUsage(before) {
      return db.run('DELETE FROM usage_records WHERE hour < ?', [before]).changes;
    },

    markInterrupted(at) {
      return db.run(
        `UPDATE requests SET status = 'FAILED', completed_at = ?, error_code = 'INTERRUPTED',
           error_message = 'The server stopped while this request was in progress.'
         WHERE status IN ('EXECUTING', 'STREAMING')`,
        [at],
      ).changes;
    },
  };
}
