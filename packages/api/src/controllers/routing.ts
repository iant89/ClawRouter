import { v, type Validator } from '@clawrouter/core';
import type { RoutingService } from '@clawrouter/routing';
import {
  CAPABILITIES, FAILOVER_POLICIES, type AliasTarget, type Capability, type FailoverPolicy, type ModelAlias, type PutRoutingRequest,
  type RoutePlan, type RoutingConfigView, type RoutingPolicy,
} from '@clawrouter/shared';
import { readJson } from '../http/body.ts';
import type { Handler, RequestContext } from '../http/context.ts';
import { ok } from '../http/responses.ts';

/*
 * Structural validation only (types and shapes). The routing service checks
 * meaning: unknown models, duplicates, ranges.
 */
type Issues = Parameters<Validator<unknown>>[2];
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function policy(value: unknown, path: string, issues: Issues): RoutingPolicy | undefined {
  if (!isObject(value)) {
    issues.push({ path, message: 'must be an object with failover, maxAttempts and retriesPerTarget' });
    return undefined;
  }
  const failover = value.failover;
  if (typeof failover !== 'string' || !(FAILOVER_POLICIES as readonly string[]).includes(failover)) {
    issues.push({ path: `${path}.failover`, message: `must be one of ${FAILOVER_POLICIES.join(', ')}` });
  }
  for (const k of ['maxAttempts', 'retriesPerTarget'] as const) {
    if (typeof value[k] !== 'number') issues.push({ path: `${path}.${k}`, message: 'must be a number' });
  }
  return { failover: failover as FailoverPolicy, maxAttempts: value.maxAttempts as number, retriesPerTarget: value.retriesPerTarget as number };
}

function target(value: unknown, path: string, issues: Issues): AliasTarget | undefined {
  if (!isObject(value) || typeof value.modelRef !== 'string' || typeof value.priority !== 'number' || typeof value.weight !== 'number') {
    issues.push({ path, message: 'must be { modelRef: string, priority: number, weight: number }' });
    return undefined;
  }
  return { modelRef: value.modelRef, priority: value.priority, weight: value.weight };
}

function alias(value: unknown, path: string, issues: Issues): ModelAlias | undefined {
  if (!isObject(value)) {
    issues.push({ path, message: 'must be an object' });
    return undefined;
  }
  const before = issues.length;
  if (typeof value.name !== 'string') issues.push({ path: `${path}.name`, message: 'must be a string' });
  if (value.description !== undefined && typeof value.description !== 'string') issues.push({ path: `${path}.description`, message: 'must be a string' });
  if (typeof value.enabled !== 'boolean') issues.push({ path: `${path}.enabled`, message: 'must be a boolean' });
  const caps = value.capabilities ?? [];
  if (!Array.isArray(caps) || !caps.every((c) => typeof c === 'string' && (CAPABILITIES as readonly string[]).includes(c))) {
    issues.push({ path: `${path}.capabilities`, message: `must be a list of: ${CAPABILITIES.join(', ')}` });
  }
  const rawTargets = value.targets ?? [];
  if (!Array.isArray(rawTargets)) issues.push({ path: `${path}.targets`, message: 'must be a list' });
  const targets = Array.isArray(rawTargets) ? rawTargets.map((t, i) => target(t, `${path}.targets[${i}]`, issues)) : [];
  const pol = value.policy === null || value.policy === undefined ? null : policy(value.policy, `${path}.policy`, issues);
  if (issues.length !== before) return undefined;
  return {
    name: value.name as string,
    description: (value.description as string | undefined) ?? '',
    enabled: value.enabled as boolean,
    capabilities: caps as Capability[],
    targets: targets as AliasTarget[],
    policy: pol ?? null,
  };
}

const putBody: Validator<PutRoutingRequest> = (value, _path, issues) => {
  if (!isObject(value)) {
    issues.push({ path: '(body)', message: 'must be an object' });
    return undefined;
  }
  const before = issues.length;
  for (const key of Object.keys(value)) if (!['version', 'defaultPolicy', 'aliases'].includes(key)) issues.push({ path: key, message: 'is not allowed' });
  if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 0) issues.push({ path: 'version', message: 'must be the version you loaded' });
  const defaultPolicy = policy(value.defaultPolicy, 'defaultPolicy', issues);
  if (!Array.isArray(value.aliases)) issues.push({ path: 'aliases', message: 'must be a list' });
  const aliases = Array.isArray(value.aliases) ? value.aliases.map((a, i) => alias(a, `aliases[${i}]`, issues)) : [];
  if (issues.length !== before) return undefined;
  return { version: value.version as number, defaultPolicy: defaultPolicy!, aliases: aliases as ModelAlias[] };
};

const previewBody = v.object({
  model: v.string({ min: 1, max: 300 }),
  capabilities: v.optional<Capability[]>((value, path, issues) => {
    if (Array.isArray(value) && value.every((c) => typeof c === 'string' && (CAPABILITIES as readonly string[]).includes(c))) return value as Capability[];
    issues.push({ path, message: `must be a list of: ${CAPABILITIES.join(', ')}` });
    return undefined;
  }),
});

const actor = (ctx: RequestContext) => ({ id: ctx.auth!.user.id, username: ctx.auth!.user.username });

/** /api/routing (spec §31) and a dry-run preview of how a model name would be routed. */
export function routingController(routing: RoutingService) {
  const get: Handler = () => ok<RoutingConfigView>(routing.get());

  const put: Handler = async (ctx) => {
    const body = await readJson(ctx, putBody, 512 * 1024);
    return ok<RoutingConfigView>(routing.update(actor(ctx), body, { ip: ctx.ip, requestId: ctx.requestId }));
  };

  const preview: Handler = async (ctx) => {
    const body = await readJson(ctx, previewBody);
    return ok<RoutePlan>(routing.plan({ model: body.model, capabilities: body.capabilities }));
  };

  return { get, put, preview };
}
