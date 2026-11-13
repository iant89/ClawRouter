import { AppError, errors, newId, type EventBus, type Logger } from '@clawrouter/core';
import type { AuditService } from '@clawrouter/audit';
import type { Database } from '@clawrouter/database';
import type {
  ApiKeyRequestInfo, ApproveKeyRequestBody, CreateKeyRequestBody, CreatedApiKey, DenyKeyRequestBody, FieldIssue, KeyExpiry, KeyRequestStatus,
} from '@clawrouter/shared';
import { checkModels, checkName, type ApiKeyService } from './api-keys.ts';
import { checkExpiry } from './expiry.ts';

/** Who is acting, with the permissions of their session. */
export interface KeyRequestActor {
  id: string;
  username: string;
  permissions: ReadonlySet<string>;
}

type Client = { ip: string | null; requestId?: string | null };

/** What the request flow needs to know about people (implemented with the authorization service). */
export interface KeyRequestDirectory {
  /** Active users holding `permission`, with their role ids. */
  holders(permission: string): { id: string; roles: string[] }[];
  rolesOf(userId: string): string[];
}

/** Pending requests one user may have open at a time. */
export const MAX_PENDING_REQUESTS = 5;

interface Row {
  id: string;
  requested_by: string;
  requester_username: string | null;
  requester_display_name: string | null;
  name: string;
  purpose: string;
  allowed_models: string;
  expiry: string;
  status: KeyRequestStatus;
  created_at: string;
  decided_by: string | null;
  decider_username: string | null;
  decided_at: string | null;
  decision_note: string | null;
  api_key_id: string | null;
}

const SELECT = `
  SELECT r.*, u.username AS requester_username, u.display_name AS requester_display_name, d.username AS decider_username
  FROM api_key_requests r
  LEFT JOIN users u ON u.id = r.requested_by
  LEFT JOIN users d ON d.id = r.decided_by`;

const toInfo = (r: Row): ApiKeyRequestInfo => ({
  id: r.id,
  name: r.name,
  purpose: r.purpose,
  allowedModels: JSON.parse(r.allowed_models) as string[],
  expiry: JSON.parse(r.expiry) as KeyExpiry,
  status: r.status,
  requestedBy: { id: r.requested_by, username: r.requester_username ?? '(deleted user)', displayName: r.requester_display_name ?? '(deleted user)' },
  createdAt: r.created_at,
  decidedBy: r.decided_by ? { id: r.decided_by, username: r.decider_username ?? '(deleted user)' } : null,
  decidedAt: r.decided_at,
  decisionNote: r.decision_note,
  apiKeyId: r.api_key_id,
});

/** Storage for key requests. */
export function createSqliteKeyRequestRepository(db: Database) {
  return {
    find: (id: string) => {
      const r = db.get<Row>(`${SELECT} WHERE r.id = ?`, [id]);
      return r ? toInfo(r) : undefined;
    },
    listByRequester: (userId: string) => db.all<Row>(`${SELECT} WHERE r.requested_by = ? ORDER BY r.created_at DESC LIMIT 100`, [userId]).map(toInfo),
    list(query: { status?: KeyRequestStatus; limit: number; offset: number }) {
      const where = query.status ? 'WHERE r.status = ?' : '';
      const params = query.status ? [query.status] : [];
      return {
        items: db.all<Row>(`${SELECT} ${where} ORDER BY r.status = 'PENDING' DESC, r.created_at DESC LIMIT ? OFFSET ?`, [...params, query.limit, query.offset]).map(toInfo),
        total: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM api_key_requests r ${where}`, params)?.n ?? 0,
      };
    },
    countPending: (userId: string) => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM api_key_requests WHERE requested_by = ? AND status = 'PENDING'", [userId])?.n ?? 0,
    insert(r: { id: string; requestedBy: string; name: string; purpose: string; allowedModels: string[]; expiry: KeyExpiry; at: string }) {
      db.run(
        `INSERT INTO api_key_requests (id, requested_by, name, purpose, allowed_models, expiry, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
        [r.id, r.requestedBy, r.name, r.purpose, JSON.stringify(r.allowedModels), JSON.stringify(r.expiry), r.at],
      );
    },
    /** Moves a request from one status to another; false when it was no longer in `from` (a concurrent decision). */
    transition(id: string, from: KeyRequestStatus, to: KeyRequestStatus, patch: { decidedBy?: string; at?: string; note?: string | null; allowedModels?: string[]; expiry?: KeyExpiry; apiKeyId?: string } = {}): boolean {
      return db.run(
        `UPDATE api_key_requests SET status = ?,
           decided_by = COALESCE(?, decided_by), decided_at = COALESCE(?, decided_at), decision_note = COALESCE(?, decision_note),
           allowed_models = COALESCE(?, allowed_models), expiry = COALESCE(?, expiry), api_key_id = COALESCE(?, api_key_id)
         WHERE id = ? AND status = ?`,
        [to, patch.decidedBy ?? null, patch.at ?? null, patch.note ?? null,
          patch.allowedModels ? JSON.stringify(patch.allowedModels) : null, patch.expiry ? JSON.stringify(patch.expiry) : null, patch.apiKeyId ?? null, id, from],
      ).changes === 1;
    },
  };
}

export type KeyRequestService = ReturnType<typeof createKeyRequestService>;

/**
 * API key requests (owner's rule): users who may not create keys ask for one;
 * everyone who may create keys for others (`api_keys.write`) and does not share
 * a role with the requester is notified. An approver approves (optionally
 * narrowing models or expiry) or denies with a reason; the requester then
 * creates the key, owned by them. Approvers never see the secret.
 */
export function createKeyRequestService(options: {
  db: Database;
  apiKeys: ApiKeyService;
  directory: KeyRequestDirectory;
  audit: AuditService;
  events?: EventBus;
  log?: Logger;
  now?: () => Date;
}) {
  const { apiKeys, directory, audit, events, log } = options;
  const repo = createSqliteKeyRequestRepository(options.db);
  const now = options.now ?? (() => new Date());

  const record = (actor: { id: string; username: string }, action: Parameters<AuditService['record']>[0]['action'], id: string, client: Client, metadata: Record<string, unknown>) =>
    audit.record({ action, result: 'SUCCESS', resource: 'api_key_request', resourceId: id, actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null, metadata });

  const get = (id: string) => {
    const r = repo.find(id);
    if (!r) throw errors.notFound('Key request not found.');
    return r;
  };

  const ownRequest = (actor: KeyRequestActor, id: string) => {
    const r = repo.find(id);
    // Someone else's request is "not found": ids cannot be probed.
    if (!r || r.requestedBy.id !== actor.id) throw errors.notFound('Key request not found.');
    return r;
  };

  const changed = (id: string, status: KeyRequestStatus) => events?.emit('api_key_request.changed', { requestId: id, status });

  /** Owner's rule: whoever shares a role with the requester neither hears about nor decides their request. */
  const sharesRole = (a: string, b: string) => {
    const theirs = new Set(directory.rolesOf(b));
    return directory.rolesOf(a).some((r) => theirs.has(r));
  };
  const assertMayDecide = (actor: KeyRequestActor, r: ApiKeyRequestInfo) => {
    if (r.requestedBy.id === actor.id) throw errors.conflict('You cannot decide your own request.');
    if (sharesRole(actor.id, r.requestedBy.id)) {
      throw new AppError('AUTHORIZATION_ERROR', `You share a role with ${r.requestedBy.username}, so someone outside their roles must decide this request.`, { expose: true });
    }
  };

  return {
    /** Approvers to notify about a request from `requesterId`: key creators who share none of the requester's roles. */
    recipientsFor(requesterId: string): string[] {
      const theirs = new Set(directory.rolesOf(requesterId));
      return directory.holders('api_keys.write')
        .filter((u) => u.id !== requesterId && !u.roles.some((r) => theirs.has(r)))
        .map((u) => u.id);
    },

    submit(actor: KeyRequestActor, body: CreateKeyRequestBody, client: Client): ApiKeyRequestInfo {
      if (actor.permissions.has('api_keys.own') || actor.permissions.has('api_keys.write')) {
        throw errors.conflict('You can create API keys yourself; no request is needed.');
      }
      const issues: FieldIssue[] = [];
      const name = checkName(body.name, issues);
      const purpose = body.purpose.trim();
      if (!purpose || purpose.length > 500) issues.push({ path: 'purpose', message: 'must be 1–500 characters: say what the key is for' });
      const allowedModels = checkModels(body.allowedModels ?? [], issues);
      // Without an expiry, ask for the longest the requester may have (never, if they have no limit).
      const longest = apiKeys.creatorLimitHours(actor.id);
      const expiry = body.expiry === undefined ? (longest === null ? { type: 'never' as const } : { type: 'after' as const, hours: longest }) : checkExpiry(body.expiry, 'expiry', issues);
      if (expiry?.type === 'at' && Date.parse(expiry.at) <= now().getTime()) issues.push({ path: 'expiry', message: 'must be in the future' });
      if (expiry && !issues.length) apiKeys.checkLifetimeFor(actor.id, allowedModels, expiry, 'expiry', issues);
      if (issues.length || !expiry) throw errors.validation(issues);
      if (repo.countPending(actor.id) >= MAX_PENDING_REQUESTS) {
        throw errors.conflict(`You already have ${MAX_PENDING_REQUESTS} requests waiting. Cancel one or wait for a decision.`);
      }

      const id = newId();
      repo.insert({ id, requestedBy: actor.id, name, purpose, allowedModels, expiry, at: now().toISOString() });
      const recipientIds = this.recipientsFor(actor.id);
      record(actor, 'API_KEY_REQUESTED', id, client, { name, allowedModels, expiry, notified: recipientIds.length });
      events?.emit('api_key_request.created', { requestId: id, requesterId: actor.id, requesterName: actor.username, keyName: name, recipientIds });
      changed(id, 'PENDING');
      if (!recipientIds.length) log?.warn('API key request has nobody to notify (no key creator outside the requester\'s roles)', { component: 'gateway', requestId: id });
      return get(id);
    },

    listMine: (actor: KeyRequestActor) => repo.listByRequester(actor.id),

    /** All requests for approvers, each marked with whether this approver may decide it (no shared role). */
    list(actor: KeyRequestActor, query: { status?: KeyRequestStatus; page: number; pageSize: number }) {
      const page = repo.list({ status: query.status, limit: query.pageSize, offset: (query.page - 1) * query.pageSize });
      return { ...page, items: page.items.map((r) => ({ ...r, decidableByYou: !sharesRole(actor.id, r.requestedBy.id) && r.requestedBy.id !== actor.id })) };
    },

    cancel(actor: KeyRequestActor, id: string, client: Client): ApiKeyRequestInfo {
      const r = ownRequest(actor, id);
      if (!repo.transition(id, 'PENDING', 'CANCELLED', { at: now().toISOString() })) throw errors.conflict(`This request is ${r.status.toLowerCase()} and can no longer be cancelled.`);
      record(actor, 'API_KEY_REQUEST_CANCELLED', id, client, { name: r.name });
      changed(id, 'CANCELLED');
      return get(id);
    },

    approve(actor: KeyRequestActor, id: string, body: ApproveKeyRequestBody, client: Client): ApiKeyRequestInfo {
      const r = get(id);
      assertMayDecide(actor, r);

      const issues: FieldIssue[] = [];
      const allowedModels = body.allowedModels === undefined ? undefined : checkModels(body.allowedModels, issues);
      const expiry = body.expiry === undefined ? undefined : checkExpiry(body.expiry, 'expiry', issues);
      const note = body.note?.trim() || null;
      if (note && note.length > 500) issues.push({ path: 'note', message: 'must be at most 500 characters' });
      // The requester creates the key, so their limit applies, not the approver's.
      if (!issues.length) apiKeys.checkLifetimeFor(r.requestedBy.id, allowedModels ?? r.allowedModels, expiry ?? r.expiry, 'expiry', issues);
      if (issues.length) throw errors.validation(issues);
      if (!repo.transition(id, 'PENDING', 'APPROVED', { decidedBy: actor.id, at: now().toISOString(), note, allowedModels, expiry })) {
        throw errors.conflict(`This request is already ${r.status.toLowerCase()}.`);
      }
      const after = get(id);
      record(actor, 'API_KEY_REQUEST_APPROVED', id, client, {
        name: r.name, requester: r.requestedBy.username,
        ...(allowedModels ? { allowedModels: { requested: r.allowedModels, approved: allowedModels } } : {}),
        ...(expiry ? { expiry: { requested: r.expiry, approved: expiry } } : {}),
      });
      events?.emit('api_key_request.decided', { requestId: id, requesterId: r.requestedBy.id, keyName: r.name, status: 'APPROVED', byName: actor.username, note });
      changed(id, 'APPROVED');
      return after;
    },

    deny(actor: KeyRequestActor, id: string, body: DenyKeyRequestBody, client: Client): ApiKeyRequestInfo {
      const r = get(id);
      assertMayDecide(actor, r);
      const reason = body.reason.trim();
      if (!reason || reason.length > 500) throw errors.validation([{ path: 'reason', message: 'must be 1–500 characters: tell the requester why' }]);
      if (!repo.transition(id, 'PENDING', 'DENIED', { decidedBy: actor.id, at: now().toISOString(), note: reason })) {
        throw errors.conflict(`This request is already ${r.status.toLowerCase()}.`);
      }
      record(actor, 'API_KEY_REQUEST_DENIED', id, client, { name: r.name, requester: r.requestedBy.username, reason });
      events?.emit('api_key_request.decided', { requestId: id, requesterId: r.requestedBy.id, keyName: r.name, status: 'DENIED', byName: actor.username, note: reason });
      changed(id, 'DENIED');
      return get(id);
    },

    /**
     * The requester creates the key from their approved request. It belongs to
     * them; the expiry is resolved now. The secret is returned once, to them only.
     */
    fulfil(actor: KeyRequestActor, id: string, client: Client): CreatedApiKey & { request: ApiKeyRequestInfo } {
      const r = ownRequest(actor, id);
      if (r.status !== 'APPROVED') throw errors.conflict(r.status === 'FULFILLED' ? 'The key for this request was already created.' : `This request is ${r.status.toLowerCase()}, not approved.`);
      const created = apiKeys.create(actor, { name: r.name, allowedModels: r.allowedModels, expiry: r.expiry }, client, { ownerId: actor.id, via: `request:${id}` });
      if (!repo.transition(id, 'APPROVED', 'FULFILLED', { apiKeyId: created.key.id })) {
        // Lost a race with a second click: revoke the duplicate rather than leave two keys.
        apiKeys.revoke(actor, created.key.id, client);
        throw new AppError('CONFLICT', 'The key for this request was already created.');
      }
      changed(id, 'FULFILLED');
      return { ...created, request: get(id) };
    },
  };
}
