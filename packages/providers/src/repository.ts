import type { Database } from '@clawapi/database';
import type { ProviderCheck, ProviderKind, ProviderState } from '@clawapi/shared';

export interface ProviderRecord {
  id: string;
  name: string;
  identifier: string;
  kind: ProviderKind;
  endpoint: string;
  enabled: boolean;
  priority: number;
  timeoutMs: number;
  status: ProviderState;
  statusDetail: string | null;
  statusCheckedAt: string | null;
  latencyMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export type ProviderPatch = Partial<Pick<ProviderRecord, 'name' | 'endpoint' | 'enabled' | 'priority' | 'timeoutMs'>>;

export interface StoredCredential {
  ciphertext: string;
  keyFingerprint: string;
  hint: string | null;
  updatedAt: string;
}

export interface ProviderRepository {
  list(): ProviderRecord[];
  findById(id: string): ProviderRecord | undefined;
  findByIdentifier(identifier: string): ProviderRecord | undefined;
  findByName(name: string): ProviderRecord | undefined;
  insert(record: ProviderRecord): void;
  update(id: string, patch: ProviderPatch, at: string): void;
  delete(id: string): boolean;
  setStatus(id: string, status: ProviderState, detail: string | null, checkedAt: string | null, latencyMs: number | null): void;

  getCredential(providerId: string, name: string): StoredCredential | undefined;
  credentialSummaries(): Map<string, { hint: string | null; updatedAt: string }>;
  putCredential(providerId: string, name: string, value: StoredCredential & { updatedBy: string | null }): 'created' | 'replaced';
  deleteCredential(providerId: string, name: string): boolean;

  addCheck(providerId: string, check: ProviderCheck): void;
  recentChecks(providerId: string, limit: number): ProviderCheck[];
  pruneChecks(before: string): number;
}

interface Row {
  id: string;
  name: string;
  identifier: string;
  kind: ProviderKind;
  endpoint: string;
  enabled: number;
  priority: number;
  timeout_ms: number;
  status: ProviderState;
  status_detail: string | null;
  status_checked_at: string | null;
  latency_ms: number | null;
  created_at: string;
  updated_at: string;
}

const toRecord = (r: Row): ProviderRecord => ({
  id: r.id,
  name: r.name,
  identifier: r.identifier,
  kind: r.kind,
  endpoint: r.endpoint,
  enabled: r.enabled === 1,
  priority: r.priority,
  timeoutMs: r.timeout_ms,
  status: r.status,
  statusDetail: r.status_detail,
  statusCheckedAt: r.status_checked_at,
  latencyMs: r.latency_ms,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const COLUMN: Record<keyof ProviderPatch, string> = { name: 'name', endpoint: 'endpoint', enabled: 'enabled', priority: 'priority', timeoutMs: 'timeout_ms' };

export function createSqliteProviderRepository(db: Database): ProviderRepository {
  return {
    list: () => db.all<Row>('SELECT * FROM providers ORDER BY priority, name COLLATE NOCASE').map(toRecord),
    findById(id) {
      const r = db.get<Row>('SELECT * FROM providers WHERE id = ?', [id]);
      return r ? toRecord(r) : undefined;
    },
    findByIdentifier(identifier) {
      const r = db.get<Row>('SELECT * FROM providers WHERE identifier = ?', [identifier]);
      return r ? toRecord(r) : undefined;
    },
    findByName(name) {
      const r = db.get<Row>('SELECT * FROM providers WHERE name = ?', [name]);
      return r ? toRecord(r) : undefined;
    },
    insert(p) {
      db.run(
        `INSERT INTO providers (id, name, identifier, kind, endpoint, enabled, priority, timeout_ms, status, status_detail, status_checked_at, latency_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [p.id, p.name, p.identifier, p.kind, p.endpoint, p.enabled ? 1 : 0, p.priority, p.timeoutMs, p.status, p.statusDetail, p.statusCheckedAt, p.latencyMs, p.createdAt, p.updatedAt],
      );
    },
    update(id, patch, at) {
      const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [keyof ProviderPatch, string | number | boolean][];
      if (!entries.length) return;
      const sets = entries.map(([k]) => `${COLUMN[k]} = ?`).join(', ');
      db.run(`UPDATE providers SET ${sets}, updated_at = ? WHERE id = ?`, [...entries.map(([, v]) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)), at, id]);
    },
    delete: (id) => db.run('DELETE FROM providers WHERE id = ?', [id]).changes > 0,
    setStatus(id, status, detail, checkedAt, latencyMs) {
      db.run('UPDATE providers SET status = ?, status_detail = ?, status_checked_at = ?, latency_ms = ? WHERE id = ?', [status, detail, checkedAt, latencyMs, id]);
    },

    getCredential(providerId, name) {
      const r = db.get<{ ciphertext: string; key_fingerprint: string; hint: string | null; updated_at: string }>(
        'SELECT ciphertext, key_fingerprint, hint, updated_at FROM provider_credentials WHERE provider_id = ? AND name = ?', [providerId, name],
      );
      return r ? { ciphertext: r.ciphertext, keyFingerprint: r.key_fingerprint, hint: r.hint, updatedAt: r.updated_at } : undefined;
    },
    credentialSummaries() {
      return new Map(
        db.all<{ provider_id: string; hint: string | null; updated_at: string }>("SELECT provider_id, hint, updated_at FROM provider_credentials WHERE name = 'api_key'")
          .map((r) => [r.provider_id, { hint: r.hint, updatedAt: r.updated_at }]),
      );
    },
    putCredential(providerId, name, v) {
      return db.transaction((tx) => {
        const exists = tx.get('SELECT 1 AS x FROM provider_credentials WHERE provider_id = ? AND name = ?', [providerId, name]) !== undefined;
        tx.run(
          `INSERT INTO provider_credentials (provider_id, name, ciphertext, key_fingerprint, hint, created_at, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider_id, name) DO UPDATE SET ciphertext = excluded.ciphertext, key_fingerprint = excluded.key_fingerprint,
             hint = excluded.hint, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          [providerId, name, v.ciphertext, v.keyFingerprint, v.hint, v.updatedAt, v.updatedAt, v.updatedBy],
        );
        return exists ? 'replaced' : 'created';
      });
    },
    deleteCredential: (providerId, name) => db.run('DELETE FROM provider_credentials WHERE provider_id = ? AND name = ?', [providerId, name]).changes > 0,

    addCheck(providerId, c) {
      db.run('INSERT INTO provider_health_history (provider_id, checked_at, check_kind, status, latency_ms, detail) VALUES (?, ?, ?, ?, ?, ?)',
        [providerId, c.checkedAt, c.kind, c.status, c.latencyMs, c.detail]);
    },
    recentChecks(providerId, limit) {
      return db.all<{ checked_at: string; check_kind: 'TEST' | 'HEALTH'; status: ProviderState; latency_ms: number | null; detail: string | null }>(
        'SELECT checked_at, check_kind, status, latency_ms, detail FROM provider_health_history WHERE provider_id = ? ORDER BY checked_at DESC, id DESC LIMIT ?',
        [providerId, limit],
      ).map((r) => ({ checkedAt: r.checked_at, kind: r.check_kind, status: r.status, latencyMs: r.latency_ms, detail: r.detail }));
    },
    pruneChecks: (before) => db.run('DELETE FROM provider_health_history WHERE checked_at < ?', [before]).changes,
  };
}
