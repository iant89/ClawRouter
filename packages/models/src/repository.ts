import type { Database } from '@clawapi/database';
import type { Capability, ModelAvailability, ModelInfo, ModelSource, ProviderKind, ProviderState } from '@clawapi/shared';

export interface ModelRecord {
  id: string;
  providerId: string;
  providerModelId: string;
  displayName: string;
  capabilities: Capability[];
  contextLength: number | null;
  maxOutputTokens: number | null;
  enabled: boolean;
  availability: ModelAvailability;
  availabilityCheckedAt: string | null;
  source: ModelSource;
  costInputPerMTok: number | null;
  costOutputPerMTok: number | null;
  createdAt: string;
  updatedAt: string;
}

export type ModelPatch = Partial<Pick<ModelRecord, 'displayName' | 'capabilities' | 'contextLength' | 'maxOutputTokens' | 'enabled' | 'costInputPerMTok' | 'costOutputPerMTok'>>;

export interface ModelFilter {
  providerId?: string;
  capability?: Capability;
  /** Case-insensitive substring of display name, model id or provider identifier. */
  q?: string;
  usableOnly?: boolean;
  limit: number;
  offset: number;
}

export interface ModelRepository {
  query(filter: ModelFilter): { items: ModelInfo[]; total: number };
  findById(id: string): ModelInfo | undefined;
  findByRef(providerIdentifier: string, providerModelId: string): ModelInfo | undefined;
  recordsForProvider(providerId: string): ModelRecord[];
  existingIds(providerId: string): Set<string>;
  insert(record: ModelRecord): void;
  update(id: string, patch: ModelPatch, at: string): void;
  setAvailability(id: string, availability: ModelAvailability, at: string, fill?: { contextLength: number | null; maxOutputTokens: number | null }): void;
  delete(id: string): boolean;
  transaction<T>(fn: () => T): T;
}

interface Row {
  id: string;
  provider_id: string;
  provider_model_id: string;
  display_name: string;
  capabilities: string;
  context_length: number | null;
  max_output_tokens: number | null;
  enabled: number;
  availability: ModelAvailability;
  availability_checked_at: string | null;
  source: ModelSource;
  cost_input_per_mtok: number | null;
  cost_output_per_mtok: number | null;
  created_at: string;
  updated_at: string;
  p_name: string;
  p_identifier: string;
  p_kind: ProviderKind;
  p_enabled: number;
  p_status: ProviderState;
}

/** The single definition of "usable", shared by filtering (SQL) and display (TS). */
const USABLE_SQL = `(m.enabled = 1 AND m.availability <> 'UNAVAILABLE' AND p.enabled = 1 AND p.status NOT IN ('OFFLINE', 'DISABLED'))`;

export function unusableReason(m: { enabled: boolean; availability: ModelAvailability }, p: { enabled: boolean; status: ProviderState }): string | null {
  if (!m.enabled) return 'Model is disabled';
  if (!p.enabled) return 'Provider is disabled';
  if (p.status === 'OFFLINE') return 'Provider is offline';
  if (p.status === 'DISABLED') return 'Provider is disabled';
  if (m.availability === 'UNAVAILABLE') return 'No longer offered by the provider';
  return null;
}

const SELECT = `
  SELECT m.*, p.name AS p_name, p.identifier AS p_identifier, p.kind AS p_kind, p.enabled AS p_enabled, p.status AS p_status
  FROM models m JOIN providers p ON p.id = m.provider_id`;

function parseCaps(json: string): Capability[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v.filter((x) => typeof x === 'string') as Capability[]) : [];
  } catch {
    return [];
  }
}

const toRecord = (r: Omit<Row, 'p_name' | 'p_identifier' | 'p_kind' | 'p_enabled' | 'p_status'>): ModelRecord => ({
  id: r.id,
  providerId: r.provider_id,
  providerModelId: r.provider_model_id,
  displayName: r.display_name,
  capabilities: parseCaps(r.capabilities),
  contextLength: r.context_length,
  maxOutputTokens: r.max_output_tokens,
  enabled: r.enabled === 1,
  availability: r.availability,
  availabilityCheckedAt: r.availability_checked_at,
  source: r.source,
  costInputPerMTok: r.cost_input_per_mtok,
  costOutputPerMTok: r.cost_output_per_mtok,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

function toInfo(r: Row): ModelInfo {
  const m = toRecord(r);
  const provider = { id: r.provider_id, name: r.p_name, identifier: r.p_identifier, kind: r.p_kind, enabled: r.p_enabled === 1, status: r.p_status };
  const reason = unusableReason(m, provider);
  return {
    id: m.id,
    ref: `${provider.identifier}/${m.providerModelId}`,
    providerId: m.providerId,
    providerModelId: m.providerModelId,
    displayName: m.displayName,
    capabilities: m.capabilities,
    contextLength: m.contextLength,
    maxOutputTokens: m.maxOutputTokens,
    enabled: m.enabled,
    availability: m.availability,
    availabilityCheckedAt: m.availabilityCheckedAt,
    source: m.source,
    cost: m.costInputPerMTok === null && m.costOutputPerMTok === null ? null : { inputPerMTok: m.costInputPerMTok, outputPerMTok: m.costOutputPerMTok, currency: 'USD' },
    provider,
    usable: reason === null,
    unusableReason: reason,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

const COLUMN: Record<keyof ModelPatch, string> = {
  displayName: 'display_name', capabilities: 'capabilities', contextLength: 'context_length', maxOutputTokens: 'max_output_tokens',
  enabled: 'enabled', costInputPerMTok: 'cost_input_per_mtok', costOutputPerMTok: 'cost_output_per_mtok',
};

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function createSqliteModelRepository(db: Database): ModelRepository {
  return {
    query({ providerId, capability, q, usableOnly, limit, offset }) {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (providerId) { where.push('m.provider_id = ?'); params.push(providerId); }
      if (capability) { where.push('EXISTS (SELECT 1 FROM json_each(m.capabilities) WHERE value = ?)'); params.push(capability); }
      if (q) {
        const like = `%${escapeLike(q.toLowerCase())}%`;
        where.push("(lower(m.display_name) LIKE ? ESCAPE '\\' OR lower(m.provider_model_id) LIKE ? ESCAPE '\\' OR lower(p.identifier) LIKE ? ESCAPE '\\')");
        params.push(like, like, like);
      }
      if (usableOnly) where.push(USABLE_SQL);
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM models m JOIN providers p ON p.id = m.provider_id ${clause}`, params)?.n ?? 0;
      const items = db.all<Row>(`${SELECT} ${clause} ORDER BY p.priority, p.name COLLATE NOCASE, m.display_name COLLATE NOCASE, m.id LIMIT ? OFFSET ?`, [...params, limit, offset]).map(toInfo);
      return { items, total };
    },
    findById(id) {
      const r = db.get<Row>(`${SELECT} WHERE m.id = ?`, [id]);
      return r ? toInfo(r) : undefined;
    },
    findByRef(identifier, providerModelId) {
      const r = db.get<Row>(`${SELECT} WHERE p.identifier = ? AND m.provider_model_id = ?`, [identifier, providerModelId]);
      return r ? toInfo(r) : undefined;
    },
    recordsForProvider(providerId) {
      return db.all<Row>('SELECT * FROM models WHERE provider_id = ?', [providerId]).map(toRecord);
    },
    existingIds(providerId) {
      return new Set(db.all<{ provider_model_id: string }>('SELECT provider_model_id FROM models WHERE provider_id = ?', [providerId]).map((r) => r.provider_model_id));
    },
    insert(m) {
      db.run(
        `INSERT INTO models (id, provider_id, provider_model_id, display_name, capabilities, context_length, max_output_tokens, enabled, availability,
           availability_checked_at, source, cost_input_per_mtok, cost_output_per_mtok, cost_currency, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [m.id, m.providerId, m.providerModelId, m.displayName, JSON.stringify(m.capabilities), m.contextLength, m.maxOutputTokens, m.enabled ? 1 : 0,
          m.availability, m.availabilityCheckedAt, m.source, m.costInputPerMTok, m.costOutputPerMTok,
          m.costInputPerMTok === null && m.costOutputPerMTok === null ? null : 'USD', m.createdAt, m.updatedAt],
      );
    },
    update(id, patch, at) {
      const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [keyof ModelPatch, unknown][];
      if (!entries.length) return;
      const values = entries.map(([k, v]) => (k === 'capabilities' ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 1 : 0) : (v as string | number | null)));
      db.run(`UPDATE models SET ${entries.map(([k]) => `${COLUMN[k]} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...values, at, id]);
      db.run("UPDATE models SET cost_currency = CASE WHEN cost_input_per_mtok IS NULL AND cost_output_per_mtok IS NULL THEN NULL ELSE 'USD' END WHERE id = ?", [id]);
    },
    setAvailability(id, availability, at, fill) {
      db.run(
        `UPDATE models SET availability = ?, availability_checked_at = ?,
           context_length = COALESCE(context_length, ?), max_output_tokens = COALESCE(max_output_tokens, ?) WHERE id = ?`,
        [availability, at, fill?.contextLength ?? null, fill?.maxOutputTokens ?? null, id],
      );
    },
    delete: (id) => db.run('DELETE FROM models WHERE id = ?', [id]).changes > 0,
    transaction: (fn) => db.transaction(() => fn()),
  };
}
