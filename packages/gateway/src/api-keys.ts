import { errors, newId, type Logger } from '@clawrouter/core';
import type { AuditService } from '@clawrouter/audit';
import type { Database } from '@clawrouter/database';
import { API_KEY_PREFIX, type ApiKeyInfo, type ApiKeyStatus, type CreateApiKeyRequest, type CreatedApiKey } from '@clawrouter/shared';

/** The identity of an authenticated external client for one request. */
export interface ApiKeyPrincipal {
  id: string;
  name: string;
  prefix: string;
  allowedModels: string[];
}

interface Row {
  id: string;
  name: string;
  prefix: string;
  secret_hash: string;
  allowed_models: string;
  created_by: string | null;
  created_by_username: string | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');

/** Constant-time comparison of two hex digests. */
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** `crk_<8 hex>_<43 base64url>`: a public id (stored, shown in lists) and 256 secret bits. */
const KEY_PATTERN = /^crk_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

/** Only write last_used_at this often per key, to keep request handling cheap. */
const LAST_USED_INTERVAL_MS = 60_000;

export type ApiKeyService = ReturnType<typeof createApiKeyService>;

/**
 * API keys for /v1/* (spec §14). The full key is returned once, at creation.
 * The database holds a SHA-256 hash, so a copy of it cannot call the gateway.
 */
export function createApiKeyService(options: { db: Database; audit: AuditService; log?: Logger; now?: () => Date }) {
  const { db, audit, log } = options;
  const now = options.now ?? (() => new Date());
  const SELECT = `SELECT k.*, u.username AS created_by_username FROM api_keys k LEFT JOIN users u ON u.id = k.created_by`;

  const statusOf = (r: Row, at: number): ApiKeyStatus =>
    r.revoked_at ? 'REVOKED' : r.expires_at && Date.parse(r.expires_at) <= at ? 'EXPIRED' : 'ACTIVE';

  const toInfo = (r: Row): ApiKeyInfo => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    allowedModels: JSON.parse(r.allowed_models) as string[],
    status: statusOf(r, now().getTime()),
    createdAt: r.created_at,
    createdBy: r.created_by ? { id: r.created_by, username: r.created_by_username ?? '(deleted user)' } : null,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  });

  return {
    list(): ApiKeyInfo[] {
      return db.all<Row>(`${SELECT} ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC`).map(toInfo);
    },

    create(actor: { id: string; username: string }, input: CreateApiKeyRequest, client: { ip: string | null; requestId?: string | null }): CreatedApiKey {
      const name = input.name.trim();
      const allowedModels = [...new Set((input.allowedModels ?? []).map((m) => m.trim()).filter(Boolean))];
      const issues = [];
      if (!name || name.length > 100) issues.push({ path: 'name', message: 'must be 1–100 characters' });
      if (allowedModels.length > 100 || allowedModels.some((m) => m.length > 300)) issues.push({ path: 'allowedModels', message: 'at most 100 model names of up to 300 characters' });
      let expiresAt: string | null = null;
      if (input.expiresAt) {
        const t = Date.parse(input.expiresAt);
        if (Number.isNaN(t)) issues.push({ path: 'expiresAt', message: 'must be an ISO date-time' });
        else if (t <= now().getTime()) issues.push({ path: 'expiresAt', message: 'must be in the future' });
        else expiresAt = new Date(t).toISOString();
      }
      if (issues.length) throw errors.validation(issues);

      const id = newId();
      const publicId = Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString('hex');
      const secret = `${API_KEY_PREFIX}${publicId}_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`;
      const prefix = `${API_KEY_PREFIX}${publicId}`;
      const at = now().toISOString();
      db.run(
        `INSERT INTO api_keys (id, name, prefix, secret_hash, allowed_models, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, name, prefix, sha256(secret), JSON.stringify(allowedModels), actor.id, at, expiresAt],
      );
      audit.record({
        action: 'API_KEY_CREATED', result: 'SUCCESS', resource: 'api_key', resourceId: id,
        actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null,
        metadata: { name, prefix, allowedModels, expiresAt },
      });
      return { key: toInfo(db.get<Row>(`${SELECT} WHERE k.id = ?`, [id])!), secret };
    },

    revoke(actor: { id: string; username: string }, id: string, client: { ip: string | null; requestId?: string | null }): ApiKeyInfo {
      const row = db.get<Row>(`${SELECT} WHERE k.id = ?`, [id]);
      if (!row) throw errors.notFound('API key not found.');
      if (!row.revoked_at) {
        db.run('UPDATE api_keys SET revoked_at = ?, revoked_by = ? WHERE id = ?', [now().toISOString(), actor.id, id]);
        audit.record({
          action: 'API_KEY_REVOKED', result: 'SUCCESS', resource: 'api_key', resourceId: id,
          actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null,
          metadata: { name: row.name, prefix: row.prefix },
        });
      }
      return toInfo(db.get<Row>(`${SELECT} WHERE k.id = ?`, [id])!);
    },

    /**
     * Authenticates a presented key. Returns null for anything that is not an
     * active key; the reason is logged, never returned to the client.
     */
    authenticate(presented: string): ApiKeyPrincipal | null {
      const match = KEY_PATTERN.exec(presented);
      if (!match) return null;
      const row = db.get<Row>(`${SELECT} WHERE k.prefix = ?`, [`${API_KEY_PREFIX}${match[1]}`]);
      if (!row || !sameHash(row.secret_hash, sha256(presented))) return null;
      const at = now();
      const status = statusOf(row, at.getTime());
      if (status !== 'ACTIVE') {
        log?.info('rejected API key', { component: 'gateway', prefix: row.prefix, status });
        return null;
      }
      if (!row.last_used_at || at.getTime() - Date.parse(row.last_used_at) >= LAST_USED_INTERVAL_MS) {
        db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [at.toISOString(), row.id]);
      }
      return { id: row.id, name: row.name, prefix: row.prefix, allowedModels: JSON.parse(row.allowed_models) as string[] };
    },
  };
}

/** Whether a key may request `model`. Empty list: any model. Names compare case-insensitively. */
export function modelAllowed(key: Pick<ApiKeyPrincipal, 'allowedModels'>, model: string): boolean {
  return key.allowedModels.length === 0 || key.allowedModels.some((m) => m.toLowerCase() === model.trim().toLowerCase());
}
