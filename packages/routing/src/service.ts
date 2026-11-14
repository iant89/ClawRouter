import { AppError, errors, type EventBus, type Logger } from '@clawrouter/core';
import type { AuditService } from '@clawrouter/audit';
import type { ModelService } from '@clawrouter/models';
import type { ProviderService } from '@clawrouter/providers';
import type { PutRoutingRequest, RoutePlan, RoutingConfig, RoutingConfigView } from '@clawrouter/shared';
import { diffConfig, routingProblems, validateRoutingConfig } from './config.ts';
import { planRoute, type RouteRequest } from './engine.ts';
import { FailureTracker } from './failures.ts';
import type { RoutingStore } from './store.ts';

export interface Actor {
  id: string;
  username: string;
}

export type RoutingService = ReturnType<typeof createRoutingService>;

/** Longest a routing snapshot is reused without a change event (see `snapshot` below). */
export const SNAPSHOT_MAX_AGE_MS = 5_000;

/**
 * Routing configuration and route planning. Plans run on a cached snapshot of
 * models and providers (see `snapshot`), handed to the pure engine.
 */
export function createRoutingService(options: {
  store: RoutingStore;
  models: ModelService;
  providers: ProviderService;
  audit: AuditService;
  events?: EventBus;
  log?: Logger;
  now?: () => Date;
  failures?: FailureTracker;
  random?: () => number;
}) {
  const { store, models, providers, audit, events, log } = options;
  const now = options.now ?? (() => new Date());
  const failures = options.failures ?? new FailureTracker(60_000, () => now().getTime());

  const load = () => ({
    config: store.load(),
    models: models.listAll(),
    providerPriority: new Map(providers.list().map((p) => [p.id, p.priority])),
  });

  // Phase 16: every gateway request plans a route, and loading the registry costs
  // ~17 ms at 5,000 models. Requests share one snapshot until a model, provider or
  // the routing configuration changes (events), and for at most SNAPSHOT_MAX_AGE_MS
  // in any case, so a change made some other way is picked up soon.
  let cached: { at: number; value: ReturnType<typeof load> } | null = null;
  const invalidate = () => {
    cached = null;
  };
  for (const name of ['model.changed', 'model.availability', 'provider.changed', 'provider.status', 'provider.models_listed', 'routing.changed'] as const) {
    events?.on(name, invalidate);
  }
  const snapshot = () => {
    const t = now().getTime();
    if (!cached || t - cached.at >= SNAPSHOT_MAX_AGE_MS || t < cached.at) cached = { at: t, value: load() };
    return cached.value;
  };

  return {
    failures,

    get(): RoutingConfigView {
      const snap = load(); // the console always sees the current state
      return { ...snap.config, problems: routingProblems(snap.config, snap.models, snap.providerPriority) };
    },

    update(actor: Actor, body: PutRoutingRequest, client: { ip: string | null; requestId?: string | null }): RoutingConfigView {
      const current = store.load();
      // Targets may reference registered models, or models already referenced before
      // (a model deleted since then must not block unrelated edits; it shows as a problem).
      const allowed = new Set([...models.listAll().map((m) => m.ref), ...current.aliases.flatMap((a) => a.targets.map((t) => t.modelRef))]);
      const issues = validateRoutingConfig(body, allowed);
      if (issues.length) throw errors.validation(issues);
      if (body.version !== current.version) {
        throw new AppError('CONFLICT', 'The routing configuration was changed by someone else. Reload it and apply your change again.', {
          details: { currentVersion: current.version },
        });
      }
      const changes = diffConfig(current, body);
      const saved = store.save({ defaultPolicy: body.defaultPolicy, aliases: body.aliases }, body.version, now().toISOString(), actor.id);
      if (!saved) throw new AppError('CONFLICT', 'The routing configuration was changed by someone else. Reload it and apply your change again.');
      audit.record({
        action: 'ROUTING_UPDATED', result: 'SUCCESS', resource: 'routing', resourceId: String(saved.version),
        actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null,
        metadata: { version: saved.version, ...changes },
      });
      events?.emit('routing.changed', { version: saved.version, updatedBy: actor.id });
      log?.info('routing configuration updated', { component: 'routing', version: saved.version });
      return this.get();
    },

    /** Plans a route; throws ROUTING_ERROR (with the excluded models) when nothing is eligible. */
    plan(request: RouteRequest): RoutePlan {
      const result = planRoute(request, { ...snapshot(), failures: (id) => failures.count(id), random: options.random });
      if (!result.ok) {
        throw new AppError('ROUTING_ERROR', result.reason, { expose: true, details: { excluded: result.excluded } });
      }
      return result.plan;
    },
  };
}

export type { RoutingConfig };
