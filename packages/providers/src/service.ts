import { AppError, errors, newId, type EventBus, type Logger, type SecretBox } from '@clawapi/core';
import type { AuditService } from '@clawapi/audit';
import {
  IDENTIFIER_PATTERN, type ConnectionTestResult, type CreateProviderRequest, type FieldIssue, type ProviderDetail, type ProviderInfo,
  type ProviderKindInfo, type ProviderState, type UpdateProviderRequest,
} from '@clawapi/shared';
import { checkEndpoint } from './endpoint.ts';
import { ProviderCallError } from './http.ts';
import type { ProviderRecord, ProviderRepository } from './repository.ts';
import type { ProviderRegistry } from './registry.ts';
import type { ChatRequest, ChatResponse, ProviderAdapter, ProviderCallContext, StreamEvent } from './types.ts';

export interface Actor {
  id: string;
  username: string;
}
export interface ClientInfo {
  ip: string | null;
  requestId?: string | null;
}

export interface ProviderServiceOptions {
  repo: ProviderRepository;
  registry: ProviderRegistry;
  secrets: SecretBox;
  audit: AuditService;
  events?: EventBus;
  log?: Logger;
  now?: () => Date;
  /** Injected into every provider call (tests use a fake). */
  fetch?: typeof fetch;
  /** A successful check slower than this marks the provider DEGRADED. */
  slowThresholdMs?: number;
  /** Timeout for connection tests and health checks (shorter than request timeouts). */
  checkTimeoutMs?: number;
}

const API_KEY = 'api_key';
const DEFAULT_PRIORITY = 100;
const DEFAULT_TIMEOUT_MS = 60_000;
export const HEALTH_HISTORY_RETENTION_DAYS = 7;

/** Problem with stored configuration (e.g. a credential sealed with another key). */
class ConfigurationProblem extends Error {}

export type ProviderService = ReturnType<typeof createProviderService>;

/**
 * Provider lifecycle, credentials, connection tests and status (spec §8, §29).
 * This is the only code that decrypts provider credentials, and only for the
 * duration of a call.
 */
export function createProviderService(options: ProviderServiceOptions) {
  const { repo, registry, secrets, audit, events, log } = options;
  const now = options.now ?? (() => new Date());
  const slowMs = options.slowThresholdMs ?? 5_000;
  const checkTimeoutMs = options.checkTimeoutMs ?? 15_000;
  const inflight = new Map<string, Promise<ConnectionTestResult>>();

  const ctxFor = (actor: Actor, client: ClientInfo) => ({ actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null });

  function toInfo(p: ProviderRecord, credentials = repo.credentialSummaries()): ProviderInfo {
    const cred = credentials.get(p.id);
    return {
      id: p.id, name: p.name, identifier: p.identifier, kind: p.kind, endpoint: p.endpoint, enabled: p.enabled,
      priority: p.priority, timeoutMs: p.timeoutMs, status: p.status, statusDetail: p.statusDetail,
      statusCheckedAt: p.statusCheckedAt, latencyMs: p.latencyMs,
      capabilities: registry.has(p.kind) ? [...registry.get(p.kind).capabilities] : [],
      credential: { configured: cred !== undefined, hint: cred?.hint ?? null, updatedAt: cred?.updatedAt ?? null },
      createdAt: p.createdAt, updatedAt: p.updatedAt,
    };
  }

  function mustGet(id: string): ProviderRecord {
    const p = repo.findById(id);
    if (!p) throw errors.notFound('Provider not found.');
    return p;
  }

  function setStatus(p: ProviderRecord, status: ProviderState, detail: string | null, latencyMs: number | null, checkedAt: string | null) {
    repo.setStatus(p.id, status, detail, checkedAt, latencyMs);
    if (status !== p.status) {
      events?.emit('provider.status', { providerId: p.id, name: p.name, previous: p.status, current: status, detail });
      log?.info('provider status changed', { component: 'providers', providerId: p.id, previous: p.status, current: status });
    }
  }

  function validateKey(apiKey: string, path = 'apiKey'): FieldIssue[] {
    if (apiKey.length < 8 || apiKey.length > 4096) return [{ path, message: 'must be between 8 and 4096 characters' }];
    if (/\s/.test(apiKey)) return [{ path, message: 'must not contain spaces or line breaks' }];
    return [];
  }

  async function storeKey(p: ProviderRecord, apiKey: string, actor: Actor, client: ClientInfo) {
    const at = now().toISOString();
    const ciphertext = await secrets.encrypt(apiKey, `provider:${p.id}:${API_KEY}`);
    // Only reveal a hint for keys long enough that 4 characters say little about them.
    const hint = apiKey.length >= 16 ? apiKey.slice(-4) : null;
    const outcome = repo.putCredential(p.id, API_KEY, { ciphertext, keyFingerprint: secrets.fingerprint, hint, updatedAt: at, updatedBy: actor.id });
    audit.record({ ...ctxFor(actor, client), action: outcome === 'created' ? 'CREDENTIAL_CREATED' : 'CREDENTIAL_REPLACED', result: 'SUCCESS', resource: 'provider', resourceId: p.id, metadata: { provider: p.identifier, credential: API_KEY } });
    events?.emit('provider.changed', { providerId: p.id, action: 'credential' });
  }

  /** Decrypts the key for one call. Never logged, never returned. */
  async function apiKeyFor(p: ProviderRecord): Promise<string | null> {
    const stored = repo.getCredential(p.id, API_KEY);
    if (!stored) return null;
    if (stored.keyFingerprint !== secrets.fingerprint) {
      throw new ConfigurationProblem('The stored API key was encrypted with a different secret key. Restore the original CLAWAPI_SECRET_KEY or enter the API key again.');
    }
    try {
      return await secrets.decrypt(stored.ciphertext, `provider:${p.id}:${API_KEY}`);
    } catch {
      throw new ConfigurationProblem('The stored API key could not be decrypted. Enter the API key again.');
    }
  }

  async function callContext(p: ProviderRecord, timeoutMs: number, signal?: AbortSignal): Promise<{ adapter: ProviderAdapter; ctx: ProviderCallContext }> {
    const adapter = registry.get(p.kind);
    const apiKey = await apiKeyFor(p);
    if (adapter.info.apiKeyRequired && !apiKey) throw new ConfigurationProblem('No API key is configured.');
    return { adapter, ctx: { endpoint: p.endpoint, apiKey, timeoutMs, signal, fetch: options.fetch } };
  }

  /** Maps a check outcome to a provider state. */
  function outcome(error: unknown, latencyMs: number | null): { status: ProviderState; detail: string } {
    if (!error) {
      return latencyMs !== null && latencyMs > slowMs
        ? { status: 'DEGRADED', detail: `Responding slowly (${latencyMs} ms)` }
        : { status: 'HEALTHY', detail: 'Connected' };
    }
    if (error instanceof ConfigurationProblem) return { status: error.message.startsWith('No API key') ? 'UNKNOWN' : 'OFFLINE', detail: error.message };
    if (error instanceof ProviderCallError) return { status: error.failure === 'rate_limited' ? 'DEGRADED' : 'OFFLINE', detail: error.message };
    log?.error('unexpected provider check failure', { component: 'providers', error });
    return { status: 'OFFLINE', detail: 'Unexpected error while checking the provider' };
  }

  async function runCheck(p: ProviderRecord, kind: 'TEST' | 'HEALTH'): Promise<{ status: ProviderState; detail: string; latencyMs: number | null; models: { id: string }[] | null; checkedAt: string }> {
    let latencyMs: number | null = null;
    let models: { id: string }[] | null = null;
    let error: unknown = null;
    try {
      const { adapter, ctx } = await callContext(p, Math.min(p.timeoutMs, checkTimeoutMs));
      if (kind === 'TEST') {
        const result = await adapter.testConnection(ctx);
        latencyMs = result.latencyMs;
        models = result.models;
      } else {
        latencyMs = (await adapter.healthCheck(ctx)).latencyMs;
      }
    } catch (e) {
      error = e;
    }
    const result = outcome(error, latencyMs);
    const checkedAt = now().toISOString();
    // A disabled provider keeps DISABLED; the check is still recorded.
    const status: ProviderState = p.enabled ? result.status : 'DISABLED';
    repo.addCheck(p.id, { checkedAt, kind, status: result.status, latencyMs, detail: result.detail });
    setStatus(p, status, result.detail, latencyMs, checkedAt);
    return { ...result, latencyMs, models, checkedAt };
  }

  const service = {
    kinds: (): ProviderKindInfo[] => registry.kinds(),

    list(): ProviderInfo[] {
      const creds = repo.credentialSummaries();
      return repo.list().map((p) => toInfo(p, creds));
    },

    get(id: string): ProviderDetail {
      const p = mustGet(id);
      return { ...toInfo(p), recentChecks: repo.recentChecks(id, 20) };
    },

    async create(actor: Actor, input: CreateProviderRequest, client: ClientInfo): Promise<ProviderInfo> {
      const issues: FieldIssue[] = [];
      if (!registry.has(input.kind)) throw errors.validation([{ path: 'kind', message: 'is not a supported provider kind' }]);
      const adapter = registry.get(input.kind);
      if (!IDENTIFIER_PATTERN.test(input.identifier)) issues.push({ path: 'identifier', message: 'must be 2–63 lowercase letters, digits or dashes, starting with a letter or digit' });
      const endpointRaw = input.endpoint?.trim() || adapter.info.defaultEndpoint;
      let endpoint = '';
      if (!endpointRaw) issues.push({ path: 'endpoint', message: 'is required for this provider kind' });
      else {
        const checked = checkEndpoint(endpointRaw);
        issues.push(...checked.issues);
        endpoint = checked.url ?? '';
      }
      if (input.apiKey !== undefined) issues.push(...validateKey(input.apiKey));
      if (issues.length) throw errors.validation(issues);
      if (repo.findByIdentifier(input.identifier)) throw errors.conflict(`A provider with identifier "${input.identifier}" already exists.`);
      if (repo.findByName(input.name)) throw errors.conflict(`A provider named "${input.name}" already exists.`);

      const at = now().toISOString();
      const enabled = input.enabled ?? true;
      const record: ProviderRecord = {
        id: newId(), name: input.name, identifier: input.identifier, kind: input.kind, endpoint, enabled,
        priority: input.priority ?? DEFAULT_PRIORITY, timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        status: enabled ? 'UNKNOWN' : 'DISABLED', statusDetail: enabled ? 'Not checked yet' : 'Disabled', statusCheckedAt: null, latencyMs: null,
        createdAt: at, updatedAt: at,
      };
      repo.insert(record);
      audit.record({ ...ctxFor(actor, client), action: 'PROVIDER_CREATED', result: 'SUCCESS', resource: 'provider', resourceId: record.id, metadata: { identifier: record.identifier, kind: record.kind, endpoint, enabled } });
      if (input.apiKey) await storeKey(record, input.apiKey, actor, client);
      events?.emit('provider.changed', { providerId: record.id, action: 'created' });
      return toInfo(mustGet(record.id));
    },

    async update(actor: Actor, id: string, patch: UpdateProviderRequest & { apiKey?: string }, client: ClientInfo): Promise<ProviderInfo> {
      const p = mustGet(id);
      const issues: FieldIssue[] = [];
      let endpoint: string | undefined;
      if (patch.endpoint !== undefined) {
        const checked = checkEndpoint(patch.endpoint);
        issues.push(...checked.issues);
        endpoint = checked.url ?? undefined;
      }
      if (patch.apiKey !== undefined) issues.push(...validateKey(patch.apiKey));
      if (issues.length) throw errors.validation(issues);
      if (patch.name !== undefined && patch.name.toLowerCase() !== p.name.toLowerCase() && repo.findByName(patch.name)) {
        throw errors.conflict(`A provider named "${patch.name}" already exists.`);
      }

      // A stored key must never follow the provider to a new host without someone re-entering it.
      const originChanged = endpoint !== undefined && new URL(endpoint).origin !== new URL(p.endpoint).origin;
      if (originChanged && repo.getCredential(id, API_KEY) && patch.apiKey === undefined) {
        throw new AppError('VALIDATION_ERROR', 'Changing the endpoint host requires entering the API key again, so the stored key is never sent to a new host.', {
          details: { issues: [{ path: 'apiKey', message: 'is required when the endpoint host changes' }] },
        });
      }

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const next = { name: patch.name, endpoint, priority: patch.priority, timeoutMs: patch.timeoutMs, enabled: patch.enabled };
      for (const [key, value] of Object.entries(next)) {
        const current = p[key as keyof typeof next];
        if (value !== undefined && value !== current) changes[key] = { from: current, to: value };
      }
      const at = now().toISOString();
      if (Object.keys(changes).length) repo.update(id, Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to])), at);

      const base = ctxFor(actor, client);
      const { enabled: enabledChange, ...otherChanges } = changes;
      if (Object.keys(otherChanges).length) {
        audit.record({ ...base, action: 'PROVIDER_UPDATED', result: 'SUCCESS', resource: 'provider', resourceId: id, metadata: { identifier: p.identifier, changes: otherChanges } });
        events?.emit('provider.changed', { providerId: id, action: 'updated' });
      }
      if (enabledChange) {
        const enabled = enabledChange.to === true;
        audit.record({ ...base, action: enabled ? 'PROVIDER_ENABLED' : 'PROVIDER_DISABLED', result: 'SUCCESS', resource: 'provider', resourceId: id, metadata: { identifier: p.identifier } });
        setStatus({ ...p }, enabled ? 'UNKNOWN' : 'DISABLED', enabled ? 'Enabled; not checked yet' : 'Disabled', null, null);
        events?.emit('provider.changed', { providerId: id, action: enabled ? 'enabled' : 'disabled' });
      } else if (otherChanges.endpoint && p.enabled) {
        setStatus(p, 'UNKNOWN', 'Endpoint changed; not checked yet', null, null);
      }
      if (patch.apiKey !== undefined) {
        await storeKey(mustGet(id), patch.apiKey, actor, client);
        if (!enabledChange && mustGet(id).enabled) setStatus(mustGet(id), 'UNKNOWN', 'API key changed; not checked yet', null, null);
      }
      return toInfo(mustGet(id));
    },

    remove(actor: Actor, id: string, client: ClientInfo): void {
      const p = mustGet(id);
      repo.delete(id);
      audit.record({ ...ctxFor(actor, client), action: 'PROVIDER_DELETED', result: 'SUCCESS', resource: 'provider', resourceId: id, metadata: { identifier: p.identifier, name: p.name } });
      events?.emit('provider.changed', { providerId: id, action: 'deleted' });
    },

    async setApiKey(actor: Actor, id: string, apiKey: string, client: ClientInfo): Promise<ProviderInfo> {
      const p = mustGet(id);
      const issues = validateKey(apiKey);
      if (issues.length) throw errors.validation(issues);
      await storeKey(p, apiKey, actor, client);
      if (p.enabled) setStatus(p, 'UNKNOWN', 'API key changed; not checked yet', null, null);
      return toInfo(mustGet(id));
    },

    removeApiKey(actor: Actor, id: string, client: ClientInfo): ProviderInfo {
      const p = mustGet(id);
      if (!repo.deleteCredential(id, API_KEY)) throw errors.notFound('No API key is stored for this provider.');
      audit.record({ ...ctxFor(actor, client), action: 'CREDENTIAL_REMOVED', result: 'SUCCESS', resource: 'provider', resourceId: id, metadata: { provider: p.identifier, credential: API_KEY } });
      events?.emit('provider.changed', { providerId: id, action: 'credential' });
      if (p.enabled && registry.get(p.kind).info.apiKeyRequired) setStatus(p, 'UNKNOWN', 'No API key is configured.', null, null);
      return toInfo(mustGet(id));
    },

    /** Connection test (spec §8). Concurrent tests of one provider share a single call. */
    test(actor: Actor, id: string, client: ClientInfo): Promise<ConnectionTestResult> {
      const existing = inflight.get(id);
      if (existing) return existing;
      const p = mustGet(id);
      const run = (async (): Promise<ConnectionTestResult> => {
        events?.emit('provider.test.started', { providerId: id });
        const r = await runCheck(p, 'TEST');
        const ok = r.status === 'HEALTHY' || (r.status === 'DEGRADED' && r.models !== null);
        audit.record({
          ...ctxFor(actor, client), action: 'CONNECTION_TEST', result: ok ? 'SUCCESS' : 'FAILURE', resource: 'provider', resourceId: id,
          metadata: { identifier: p.identifier, status: r.status, latencyMs: r.latencyMs, detail: r.detail },
        });
        if (ok) events?.emit('provider.test.completed', { providerId: id, status: r.status, latencyMs: r.latencyMs });
        else events?.emit('provider.test.failed', { providerId: id, status: r.status, message: r.detail });
        return {
          ok, status: r.status, latencyMs: r.latencyMs,
          message: ok ? `${r.detail}. ${r.models?.length ?? 0} model(s) available.` : r.detail,
          modelCount: r.models?.length ?? null, sampleModels: (r.models ?? []).slice(0, 5).map((m) => m.id), checkedAt: r.checkedAt,
        };
      })().finally(() => inflight.delete(id));
      inflight.set(id, run);
      return run;
    },

    /** Background health check of every enabled provider (spec §8 healthCheck). */
    async checkAll(): Promise<void> {
      await Promise.all(repo.list().filter((p) => p.enabled).map((p) => runCheck(p, 'HEALTH').catch((error) => log?.error('provider health check failed', { component: 'providers', providerId: p.id, error }))));
    },

    pruneHistory: () => repo.pruneChecks(new Date(now().getTime() - HEALTH_HISTORY_RETENTION_DAYS * 86_400_000).toISOString()),

    /** Summary for the platform health endpoint (counts only, no names). */
    healthSummary(): { status: 'HEALTHY' | 'DEGRADED' | 'OFFLINE' | 'DISABLED' | 'UNKNOWN'; detail: string } {
      const enabled = repo.list().filter((p) => p.enabled);
      if (!enabled.length) return { status: 'DISABLED', detail: 'No providers enabled' };
      const count = (s: ProviderState) => enabled.filter((p) => p.status === s).length;
      const healthy = count('HEALTHY');
      const detail = `${healthy} of ${enabled.length} enabled provider(s) healthy`;
      if (healthy === enabled.length) return { status: 'HEALTHY', detail };
      if (healthy === 0 && count('OFFLINE') === enabled.length) return { status: 'OFFLINE', detail };
      if (healthy === 0 && count('DEGRADED') === 0 && count('OFFLINE') === 0) return { status: 'UNKNOWN', detail: `${detail}; not checked yet` };
      return { status: 'DEGRADED', detail };
    },

    /**
     * One standardized call into any provider (used by the gateway, phase 8).
     * `providerId` is the ClawAPI provider id; `request.model` the provider's model id.
     */
    async chat(providerId: string, request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
      const p = mustGet(providerId);
      if (!p.enabled) throw new AppError('ROUTING_ERROR', 'Provider is disabled.');
      const { adapter, ctx } = await callContext(p, p.timeoutMs, signal).catch((e) => {
        throw e instanceof ConfigurationProblem ? new AppError('PROVIDER_ERROR', e.message, { expose: true }) : e;
      });
      return adapter.sendRequest(ctx, request);
    },

    async *chatStream(providerId: string, request: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
      const p = mustGet(providerId);
      if (!p.enabled) throw new AppError('ROUTING_ERROR', 'Provider is disabled.');
      const { adapter, ctx } = await callContext(p, p.timeoutMs, signal).catch((e) => {
        throw e instanceof ConfigurationProblem ? new AppError('PROVIDER_ERROR', e.message, { expose: true }) : e;
      });
      yield* adapter.sendStreamingRequest(ctx, request);
    },
  };
  return service;
}
