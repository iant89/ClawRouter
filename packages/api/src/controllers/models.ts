import { errors, v, type Validator } from '@clawapi/core';
import type { ModelService } from '@clawapi/models';
import { CAPABILITIES, type Capability, type DiscoveredModelInfo, type ImportModelsResult, type ModelInfo } from '@clawapi/shared';
import { readJson } from '../http/body.ts';
import type { Handler, RequestContext } from '../http/context.ts';
import { created, noContent, ok } from '../http/responses.ts';

const capabilities: Validator<Capability[]> = (value, path, issues) => {
  if (!Array.isArray(value) || value.length > CAPABILITIES.length || !value.every((c) => typeof c === 'string' && (CAPABILITIES as readonly string[]).includes(c))) {
    issues.push({ path, message: `must be a list of: ${CAPABILITIES.join(', ')}` });
    return undefined;
  }
  return value as Capability[];
};

/** A positive integer, or null to clear. `undefined` (absent) is left to v.optional. */
const tokens: Validator<number | null> = (value, path, issues) => {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  issues.push({ path, message: 'must be a positive whole number or null' });
  return undefined;
};
const nullableTokens: Validator<number | null | undefined> = (value, path, issues) => (value === undefined ? undefined : tokens(value, path, issues));

const price: Validator<number | null> = (value, path, issues) => {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  issues.push({ path, message: 'must be a non-negative number or null' });
  return undefined;
};

const cost: Validator<{ inputPerMTok: number | null; outputPerMTok: number | null } | null | undefined> = (value, path, issues) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ path, message: 'must be an object with inputPerMTok and outputPerMTok, or null' });
    return undefined;
  }
  const c = value as Record<string, unknown>;
  const before = issues.length;
  const inputPerMTok = price(c.inputPerMTok ?? null, `${path}.inputPerMTok`, issues);
  const outputPerMTok = price(c.outputPerMTok ?? null, `${path}.outputPerMTok`, issues);
  return issues.length === before ? { inputPerMTok: inputPerMTok ?? null, outputPerMTok: outputPerMTok ?? null } : undefined;
};

const createBody = v.object({
  providerId: v.string({ min: 1, max: 64 }),
  providerModelId: v.string({ min: 1, max: 256 }),
  displayName: v.optional(v.string({ min: 1, max: 200 })),
  capabilities: v.optional(capabilities),
  contextLength: nullableTokens,
  maxOutputTokens: nullableTokens,
  enabled: v.optional(v.boolean()),
  cost,
});

const updateBody = v.object({
  displayName: v.optional(v.string({ min: 1, max: 200 })),
  capabilities: v.optional(capabilities),
  contextLength: nullableTokens,
  maxOutputTokens: nullableTokens,
  enabled: v.optional(v.boolean()),
  cost,
});

const importBody = v.object({
  providerModelIds: (value, path, issues) => {
    if (!Array.isArray(value) || !value.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 256)) {
      issues.push({ path, message: 'must be a list of model ids' });
      return undefined;
    }
    return value as string[];
  },
});

const actor = (ctx: RequestContext) => ({ id: ctx.auth!.user.id, username: ctx.auth!.user.username });
const client = (ctx: RequestContext) => ({ ip: ctx.ip, requestId: ctx.requestId });
const idOf = (ctx: RequestContext) => {
  if (!ctx.params.id) throw errors.notFound();
  return ctx.params.id;
};

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw errors.validation([{ path: name, message: `must be an integer between ${min} and ${max}` }]);
  return n;
}

/** /api/models (spec §31) and model discovery under /api/providers/:id/models. */
export function modelsController(models: ModelService) {
  const list: Handler = (ctx) => {
    const url = ctx.url;
    const capability = url.searchParams.get('capability') || undefined;
    if (capability && !(CAPABILITIES as readonly string[]).includes(capability)) throw errors.validation([{ path: 'capability', message: `must be one of ${CAPABILITIES.join(', ')}` }]);
    const q = url.searchParams.get('q') ?? undefined;
    if (q && q.length > 200) throw errors.validation([{ path: 'q', message: 'must be at most 200 characters' }]);
    const result = models.list({
      page: intParam(url, 'page', 1, 1, 1_000_000),
      pageSize: intParam(url, 'pageSize', 50, 1, 200),
      providerId: url.searchParams.get('providerId') || undefined,
      capability: capability as Capability | undefined,
      q,
      usableOnly: url.searchParams.get('usable') === 'true',
    });
    return ok<ModelInfo[]>(result.items, { meta: { page: result.page, pageSize: result.pageSize, total: result.total } });
  };

  const get: Handler = (ctx) => ok<ModelInfo>(models.get(idOf(ctx)));

  const create: Handler = async (ctx) => {
    const body = await readJson(ctx, createBody);
    const model = models.create(actor(ctx), { ...body, cost: body.cost ?? undefined }, client(ctx));
    return created<ModelInfo>(model, `/api/models/${model.id}`);
  };

  const update: Handler = async (ctx) => {
    const body = await readJson(ctx, updateBody);
    return ok<ModelInfo>(models.update(actor(ctx), idOf(ctx), body, client(ctx)));
  };

  const remove: Handler = (ctx) => {
    models.remove(actor(ctx), idOf(ctx), client(ctx));
    return noContent();
  };

  const discover: Handler = async (ctx) => ok<DiscoveredModelInfo[]>(await models.discover(idOf(ctx)));

  const importModels: Handler = async (ctx) => {
    const body = await readJson(ctx, importBody);
    return ok<ImportModelsResult>(await models.import(actor(ctx), idOf(ctx), body.providerModelIds, client(ctx)));
  };

  return { list, get, create, update, remove, discover, importModels };
}
