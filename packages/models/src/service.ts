import { errors, newId, type EventBus, type Logger } from '@clawapi/core';
import type { AuditService } from '@clawapi/audit';
import type { ProviderService } from '@clawapi/providers';
import {
  CAPABILITIES, type Capability, type CreateModelRequest, type DiscoveredModelInfo, type FieldIssue, type ImportModelsResult,
  type ModelInfo, type ModelQuery, type UpdateModelRequest,
} from '@clawapi/shared';
import type { ModelPatch, ModelRecord, ModelRepository } from './repository.ts';

export interface Actor {
  id: string;
  username: string;
}
export interface ClientInfo {
  ip: string | null;
  requestId?: string | null;
}

type ListedModel = { id: string; displayName: string | null; contextLength: number | null; maxOutputTokens: number | null; kind: 'chat' | 'embedding' | 'other' };

/** Capabilities pre-selected for a discovered model; administrators refine them. */
export function defaultCapabilities(kind: ListedModel['kind'], providerCaps: readonly Capability[]): Capability[] {
  const want: Capability[] = kind === 'chat' ? ['CHAT'] : kind === 'embedding' ? ['EMBEDDINGS'] : [];
  return want.filter((c) => providerCaps.includes(c));
}

const MAX_TOKENS_LIMIT = 100_000_000;
const MAX_IMPORT = 500;

export type ModelService = ReturnType<typeof createModelService>;

/**
 * The model registry (spec §9): first-class models that belong to providers,
 * with capabilities, limits, cost metadata and availability. This is how
 * providers expose usable models to the rest of ClawAPI (routing, gateway).
 */
export function createModelService(options: {
  repo: ModelRepository;
  providers: ProviderService;
  audit: AuditService;
  events?: EventBus;
  log?: Logger;
  now?: () => Date;
}) {
  const { repo, providers, audit, events, log } = options;
  const now = options.now ?? (() => new Date());
  const base = (actor: Actor, client: ClientInfo) => ({ actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null });

  function mustGet(id: string): ModelInfo {
    const m = repo.findById(id);
    if (!m) throw errors.notFound('Model not found.');
    return m;
  }

  function validate(input: Partial<CreateModelRequest>, issues: FieldIssue[]) {
    if (input.providerModelId !== undefined && (!input.providerModelId.trim() || input.providerModelId.length > 256 || /[\s\u0000-\u001f]/.test(input.providerModelId))) {
      issues.push({ path: 'providerModelId', message: 'must be 1–256 characters without spaces' });
    }
    if (input.displayName !== undefined && (!input.displayName.trim() || input.displayName.length > 200)) issues.push({ path: 'displayName', message: 'must be 1–200 characters' });
    if (input.capabilities !== undefined) {
      const bad = input.capabilities.filter((c) => !(CAPABILITIES as readonly string[]).includes(c));
      if (bad.length) issues.push({ path: 'capabilities', message: `unknown capability: ${bad.join(', ')}` });
    }
    for (const field of ['contextLength', 'maxOutputTokens'] as const) {
      const v = input[field];
      if (v !== undefined && v !== null && (!Number.isInteger(v) || v < 1 || v > MAX_TOKENS_LIMIT)) issues.push({ path: field, message: `must be a whole number from 1 to ${MAX_TOKENS_LIMIT}` });
    }
    if (input.cost) {
      for (const field of ['inputPerMTok', 'outputPerMTok'] as const) {
        const v = input.cost[field];
        if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100_000)) issues.push({ path: `cost.${field}`, message: 'must be a price from 0 to 100000 (USD per million tokens)' });
      }
    }
  }

  const dedupe = (caps: Capability[]) => CAPABILITIES.filter((c) => caps.includes(c));

  function insertModel(actor: Actor, client: ClientInfo, record: Omit<ModelRecord, 'id' | 'createdAt' | 'updatedAt'>): ModelInfo {
    const at = now().toISOString();
    const id = newId();
    repo.insert({ ...record, id, createdAt: at, updatedAt: at });
    const info = mustGet(id);
    audit.record({ ...base(actor, client), action: 'MODEL_CREATED', result: 'SUCCESS', resource: 'model', resourceId: id, metadata: { ref: info.ref, source: record.source } });
    events?.emit('model.changed', { modelId: id, providerId: record.providerId, action: 'created' });
    return info;
  }

  const service = {
    list(query: ModelQuery = {}): { items: ModelInfo[]; total: number; page: number; pageSize: number } {
      const page = Math.max(1, query.page ?? 1);
      const pageSize = Math.min(Math.max(query.pageSize ?? 50, 1), 200);
      const { items, total } = repo.query({
        providerId: query.providerId, capability: query.capability, q: query.q?.trim() || undefined, usableOnly: query.usableOnly,
        limit: pageSize, offset: (page - 1) * pageSize,
      });
      return { items, total, page, pageSize };
    },

    get: (id: string) => mustGet(id),

    /** Manually registered model (providers that cannot list models, or unlisted ones). */
    create(actor: Actor, input: CreateModelRequest, client: ClientInfo): ModelInfo {
      const issues: FieldIssue[] = [];
      validate(input, issues);
      if (issues.length) throw errors.validation(issues);
      const provider = providers.get(input.providerId); // throws NOT_FOUND
      if (repo.existingIds(provider.id).has(input.providerModelId)) throw errors.conflict(`"${provider.identifier}/${input.providerModelId}" is already registered.`);
      return insertModel(actor, client, {
        providerId: provider.id,
        providerModelId: input.providerModelId,
        displayName: input.displayName?.trim() || input.providerModelId,
        capabilities: dedupe(input.capabilities ?? ['CHAT']),
        contextLength: input.contextLength ?? null,
        maxOutputTokens: input.maxOutputTokens ?? null,
        enabled: input.enabled ?? true,
        availability: 'UNKNOWN',
        availabilityCheckedAt: null,
        source: 'MANUAL',
        costInputPerMTok: input.cost?.inputPerMTok ?? null,
        costOutputPerMTok: input.cost?.outputPerMTok ?? null,
      });
    },

    update(actor: Actor, id: string, input: UpdateModelRequest, client: ClientInfo): ModelInfo {
      const current = mustGet(id);
      const issues: FieldIssue[] = [];
      validate(input, issues);
      if (issues.length) throw errors.validation(issues);

      const patch: ModelPatch = {
        displayName: input.displayName?.trim(),
        capabilities: input.capabilities ? dedupe(input.capabilities) : undefined,
        contextLength: input.contextLength,
        maxOutputTokens: input.maxOutputTokens,
        enabled: input.enabled,
        ...(input.cost !== undefined
          ? { costInputPerMTok: input.cost?.inputPerMTok ?? null, costOutputPerMTok: input.cost?.outputPerMTok ?? null }
          : {}),
      };
      const before: Record<string, unknown> = {
        displayName: current.displayName, capabilities: current.capabilities, contextLength: current.contextLength, maxOutputTokens: current.maxOutputTokens,
        enabled: current.enabled, costInputPerMTok: current.cost?.inputPerMTok ?? null, costOutputPerMTok: current.cost?.outputPerMTok ?? null,
      };
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined && JSON.stringify(value) !== JSON.stringify(before[key])) changes[key] = { from: before[key], to: value };
      }
      if (!Object.keys(changes).length) return current;
      repo.update(id, Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to])) as ModelPatch, now().toISOString());

      const { enabled, ...rest } = changes;
      const ctx = base(actor, client);
      if (Object.keys(rest).length) {
        audit.record({ ...ctx, action: 'MODEL_UPDATED', result: 'SUCCESS', resource: 'model', resourceId: id, metadata: { ref: current.ref, changes: rest } });
        events?.emit('model.changed', { modelId: id, providerId: current.providerId, action: 'updated' });
      }
      if (enabled) {
        audit.record({ ...ctx, action: enabled.to ? 'MODEL_ENABLED' : 'MODEL_DISABLED', result: 'SUCCESS', resource: 'model', resourceId: id, metadata: { ref: current.ref } });
        events?.emit('model.changed', { modelId: id, providerId: current.providerId, action: enabled.to ? 'enabled' : 'disabled' });
      }
      return mustGet(id);
    },

    remove(actor: Actor, id: string, client: ClientInfo): void {
      const m = mustGet(id);
      repo.delete(id);
      audit.record({ ...base(actor, client), action: 'MODEL_DELETED', result: 'SUCCESS', resource: 'model', resourceId: id, metadata: { ref: m.ref } });
      events?.emit('model.changed', { modelId: id, providerId: m.providerId, action: 'deleted' });
    },

    /** Live model list from the provider, marked with what is already registered (spec §9 discovery). */
    async discover(providerId: string): Promise<DiscoveredModelInfo[]> {
      const { provider, models } = await providers.listModels(providerId);
      const existing = repo.existingIds(providerId);
      return models
        .map((m) => ({
          providerModelId: m.id,
          displayName: m.displayName,
          contextLength: m.contextLength ?? null,
          maxOutputTokens: m.maxOutputTokens ?? null,
          capabilities: defaultCapabilities(m.kind ?? 'chat', provider.capabilities),
          registered: existing.has(m.id),
        }))
        .sort((a, b) => Number(a.registered) - Number(b.registered) || a.providerModelId.localeCompare(b.providerModelId));
    },

    /**
     * Imports selected models. The list is fetched again on the server: only
     * models the provider actually offers can be imported.
     */
    async import(actor: Actor, providerId: string, providerModelIds: string[], client: ClientInfo): Promise<ImportModelsResult> {
      const wanted = [...new Set(providerModelIds)];
      if (!wanted.length || wanted.length > MAX_IMPORT) throw errors.validation([{ path: 'providerModelIds', message: `must list 1–${MAX_IMPORT} models` }]);
      const { provider, models } = await providers.listModels(providerId);
      const offered = new Map(models.map((m) => [m.id, m]));
      const unknown = wanted.filter((id) => !offered.has(id));
      if (unknown.length) {
        throw errors.validation([{ path: 'providerModelIds', message: `not offered by the provider: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}` }]);
      }
      const existing = repo.existingIds(providerId);
      const at = now().toISOString();
      const created = repo.transaction(() =>
        wanted.filter((id) => !existing.has(id)).map((id) => {
          const m = offered.get(id)!;
          return insertModel(actor, client, {
            providerId,
            providerModelId: id,
            displayName: m.displayName ?? id,
            capabilities: defaultCapabilities(m.kind ?? 'chat', provider.capabilities),
            contextLength: m.contextLength ?? null,
            maxOutputTokens: m.maxOutputTokens ?? null,
            enabled: true,
            availability: 'AVAILABLE',
            availabilityCheckedAt: at,
            source: 'DISCOVERED',
            costInputPerMTok: null,
            costOutputPerMTok: null,
          });
        }),
      );
      return { imported: created.length, skipped: wanted.length - created.length, models: created };
    },

    /**
     * Applies a provider's model list to the registry: listed models become
     * AVAILABLE (missing limits are filled in, never overwritten); registered
     * models the provider no longer lists become UNAVAILABLE.
     */
    applyModelList(providerId: string, listed: ListedModel[]): void {
      const byId = new Map(listed.map((m) => [m.id, m]));
      const at = now().toISOString();
      const changed: { record: ModelRecord; to: 'AVAILABLE' | 'UNAVAILABLE' }[] = [];
      repo.transaction(() => {
        for (const record of repo.recordsForProvider(providerId)) {
          const hit = byId.get(record.providerModelId);
          const to = hit ? 'AVAILABLE' : 'UNAVAILABLE';
          repo.setAvailability(record.id, to, at, hit ? { contextLength: hit.contextLength, maxOutputTokens: hit.maxOutputTokens } : undefined);
          if (record.availability !== to) changed.push({ record, to });
        }
      });
      for (const { record, to } of changed) {
        const info = repo.findById(record.id);
        events?.emit('model.changed', { modelId: record.id, providerId, action: 'availability' });
        if (info) events?.emit('model.availability', { modelId: record.id, ref: info.ref, displayName: info.displayName, previous: record.availability, current: to });
      }
      if (changed.length) log?.info('model availability changed', { component: 'models', providerId, changed: changed.length });
    },

    /** Keeps availability current from every provider model listing. Returns an unsubscribe function. */
    subscribe(bus: EventBus): () => void {
      return bus.on('provider.models_listed', ({ providerId, models }) => {
        try {
          service.applyModelList(providerId, models);
        } catch (error) {
          log?.error('could not apply model list', { component: 'models', providerId, error });
        }
      });
    },

    /** Usable models, optionally with a capability: the input to routing (phase 7). */
    listUsable(capability?: Capability): ModelInfo[] {
      return repo.query({ capability, usableOnly: true, limit: 10_000, offset: 0 }).items;
    },

    /** Resolves a public reference `<provider identifier>/<provider model id>`. */
    resolveRef(ref: string): ModelInfo | undefined {
      const slash = ref.indexOf('/');
      if (slash <= 0) return undefined;
      return repo.findByRef(ref.slice(0, slash), ref.slice(slash + 1));
    },
  };
  return service;
}
