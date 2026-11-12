import { errors, v, type Validator } from '@clawapi/core';
import type { ProviderService } from '@clawapi/providers';
import { PROVIDER_KINDS, type ConnectionTestResult, type ProviderDetail, type ProviderInfo, type ProviderKind, type ProviderKindInfo } from '@clawapi/shared';
import { readJson } from '../http/body.ts';
import type { Handler, RequestContext } from '../http/context.ts';
import { created, noContent, ok } from '../http/responses.ts';

const int = (min: number, max: number): Validator<number> => (value, path, issues) => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    issues.push({ path, message: value === undefined ? 'is required' : `must be an integer between ${min} and ${max}` });
    return undefined;
  }
  return value;
};

const kind: Validator<ProviderKind> = (value, path, issues) => {
  if (typeof value === 'string' && (PROVIDER_KINDS as readonly string[]).includes(value)) return value as ProviderKind;
  issues.push({ path, message: `must be one of ${PROVIDER_KINDS.join(', ')}` });
  return undefined;
};

// API keys are not trimmed or otherwise altered: whitespace is rejected by the service.
const apiKey = v.string({ min: 1, max: 4096, trim: false });

const createBody = v.object({
  name: v.string({ min: 1, max: 100 }),
  identifier: v.string({ min: 2, max: 63 }),
  kind,
  endpoint: v.optional(v.string({ min: 1, max: 2048 })),
  priority: v.optional(int(0, 10_000)),
  timeoutMs: v.optional(int(1_000, 600_000)),
  enabled: v.optional(v.boolean()),
  apiKey: v.optional(apiKey),
});

const updateBody = v.object({
  name: v.optional(v.string({ min: 1, max: 100 })),
  endpoint: v.optional(v.string({ min: 1, max: 2048 })),
  priority: v.optional(int(0, 10_000)),
  timeoutMs: v.optional(int(1_000, 600_000)),
  enabled: v.optional(v.boolean()),
  apiKey: v.optional(apiKey),
});

const keyBody = v.object({ apiKey });

const actor = (ctx: RequestContext) => ({ id: ctx.auth!.user.id, username: ctx.auth!.user.username });
const client = (ctx: RequestContext) => ({ ip: ctx.ip, requestId: ctx.requestId });
const idOf = (ctx: RequestContext) => {
  if (!ctx.params.id) throw errors.notFound();
  return ctx.params.id;
};

/** /api/providers (spec §31). Credentials are write-only: requests may carry them, responses never do. */
export function providersController(providers: ProviderService) {
  const kinds: Handler = () => ok<ProviderKindInfo[]>(providers.kinds());
  const list: Handler = () => ok<ProviderInfo[]>(providers.list());
  const get: Handler = (ctx) => ok<ProviderDetail>(providers.get(idOf(ctx)));

  const create: Handler = async (ctx) => {
    const body = await readJson(ctx, createBody);
    const provider = await providers.create(actor(ctx), body, client(ctx));
    return created<ProviderInfo>(provider, `/api/providers/${provider.id}`);
  };

  const update: Handler = async (ctx) => {
    const body = await readJson(ctx, updateBody);
    return ok<ProviderInfo>(await providers.update(actor(ctx), idOf(ctx), body, client(ctx)));
  };

  const remove: Handler = (ctx) => {
    providers.remove(actor(ctx), idOf(ctx), client(ctx));
    return noContent();
  };

  const putKey: Handler = async (ctx) => {
    const body = await readJson(ctx, keyBody);
    return ok<ProviderInfo>(await providers.setApiKey(actor(ctx), idOf(ctx), body.apiKey, client(ctx)));
  };

  const deleteKey: Handler = (ctx) => ok<ProviderInfo>(providers.removeApiKey(actor(ctx), idOf(ctx), client(ctx)));

  const test: Handler = async (ctx) => ok<ConnectionTestResult>(await providers.test(actor(ctx), idOf(ctx), client(ctx)));

  return { kinds, list, get, create, update, remove, putKey, deleteKey, test };
}
