import { errors, v, type Validator } from '@clawrouter/core';
import type { ApiKeyService, GatewayResult, GatewayService } from '@clawrouter/gateway';
import { API_KEY_STATUSES, type ApiKeyInfo, type ApiKeyStatus, type CreatedApiKey, type GatewayMetrics, type KeyExpiry, type RateLimit } from '@clawrouter/shared';
import { readJson, readJsonValue } from '../http/body.ts';
import type { Handler, RequestContext } from '../http/context.ts';
import { created, json, ok } from '../http/responses.ts';

/** Chat requests can carry long conversations. */
const GATEWAY_BODY_LIMIT = 10 * 1024 * 1024;

/** Reads a JSON body for /v1 without imposing a schema: the gateway validates it in OpenAI terms. */
const readGatewayBody = (ctx: RequestContext): Promise<unknown> => readJsonValue(ctx, GATEWAY_BODY_LIMIT);

function toResponse(result: GatewayResult): Response {
  if (result.kind === 'json') return json(result.body, { status: result.status, headers: result.headers });
  return new Response(result.stream, { status: 200, headers: result.headers });
}

/** The dispatcher guarantees an API key on 'api_key' routes. */
const key = (ctx: RequestContext) => ctx.apiKey!;
const gwContext = (ctx: RequestContext) => ({ requestId: ctx.requestId, signal: ctx.request.signal });

/** External AI API, OpenAI-compatible (spec §7, §32). */
export function gatewayController(gateway: GatewayService) {
  const models: Handler = (ctx) => json(gateway.listModels(key(ctx)));
  const chat: Handler = async (ctx) => toResponse(await gateway.chat(key(ctx), await readGatewayBody(ctx), gwContext(ctx)));
  const embeddings: Handler = async (ctx) => toResponse(await gateway.embeddings(key(ctx), await readGatewayBody(ctx), gwContext(ctx)));
  const responses: Handler = () => gateway.responses();
  const metrics: Handler = () => ok<GatewayMetrics>(gateway.metrics.snapshot());
  return { models, chat, embeddings, responses, metrics };
}

export const modelList = v.optional<string[]>((value, path, issues) => {
  if (Array.isArray(value) && value.every((m) => typeof m === 'string')) return value as string[];
  issues.push({ path, message: 'must be a list of model names' });
  return undefined;
});

/** `{ requestsPerMinute, tokensPerMinute }` or null (shape only; the service checks the values). */
const keyLimit: Validator<RateLimit | null | undefined> = (value, path, issues) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const isLimitValue = (x: unknown) => x === undefined || x === null || typeof x === 'number';
  if (typeof value === 'object' && !Array.isArray(value)) {
    const l = value as Record<string, unknown>;
    if (Object.keys(l).every((k) => k === 'requestsPerMinute' || k === 'tokensPerMinute') && isLimitValue(l.requestsPerMinute) && isLimitValue(l.tokensPerMinute)) {
      return { requestsPerMinute: (l.requestsPerMinute as number | null | undefined) ?? null, tokensPerMinute: (l.tokensPerMinute as number | null | undefined) ?? null };
    }
  }
  issues.push({ path, message: 'must be { requestsPerMinute, tokensPerMinute } (numbers or null), or null for the default limit' });
  return undefined;
};

/** Shape only; the key service checks the expiry in detail. */
export const expiryField: Validator<KeyExpiry | undefined> = (value, path, issues) => {
  if (value === undefined) return undefined;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as KeyExpiry;
  issues.push({ path, message: 'must be an expiry object' });
  return undefined;
};

const createKeyBody = v.object({
  name: v.string({ min: 1, max: 100 }),
  allowedModels: modelList,
  expiresAt: (value, path, issues) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string') return value;
    issues.push({ path, message: 'must be an ISO date-time or null' });
    return undefined;
  },
  expiry: expiryField,
  rateLimit: keyLimit,
});

const updateKeyBody = v.object({
  name: v.optional(v.string({ min: 1, max: 100 })),
  allowedModels: modelList,
  rateLimit: keyLimit,
});

const actor = (ctx: RequestContext) => ({ id: ctx.auth!.user.id, username: ctx.auth!.user.username });

/** /api/api-keys (spec §31): create (the only time the key is shown), list, revoke. */
export function apiKeysController(apiKeys: ApiKeyService) {
  /** One page of keys (`page`, `pageSize` up to 200, `q`, `status`); meta has the total and the active count. */
  const list: Handler = (ctx) => {
    const params = ctx.url.searchParams;
    const int = (name: string, fallback: number, max: number) => {
      const raw = params.get(name);
      const n = raw === null || raw === '' ? fallback : Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > max) throw errors.validation([{ path: name, message: `must be an integer from 1 to ${max}` }]);
      return n;
    };
    const status = params.get('status') || undefined;
    if (status && !(API_KEY_STATUSES as readonly string[]).includes(status)) throw errors.validation([{ path: 'status', message: `must be one of ${API_KEY_STATUSES.join(', ')}` }]);
    const q = (params.get('q') ?? '').slice(0, 200);
    const page = { page: int('page', 1, 1_000_000), pageSize: int('pageSize', 50, 200) };
    const { items, total, active } = apiKeys.query({ ...page, q, status: status as ApiKeyStatus | undefined });
    return ok<ApiKeyInfo[]>(items, { meta: { ...page, total, active } });
  };
  /** Active keys of non-administrators lasting longer than `days` (Settings shows them when the limit is lowered). */
  const beyondLifetime: Handler = (ctx) => {
    const int = (name: string, fallback: number | null, min: number, max: number) => {
      const raw = ctx.url.searchParams.get(name);
      const n = raw === null || raw === '' ? fallback : Number(raw);
      if (n === null || !Number.isInteger(n) || n < min || n > max) throw errors.validation([{ path: name, message: `must be an integer from ${min} to ${max}` }]);
      return n;
    };
    const days = int('days', null, 1, 3650);
    const q = { page: int('page', 1, 1, 1_000_000), pageSize: int('pageSize', 25, 1, 100) };
    const { items, total } = apiKeys.beyondLifetime(days * 24, q);
    return ok<ApiKeyInfo[]>(items, { meta: { ...q, total } });
  };
  const create: Handler = async (ctx) => {
    const body = await readJson(ctx, createKeyBody);
    const result = apiKeys.create(actor(ctx), body, { ip: ctx.ip, requestId: ctx.requestId });
    // The response carries a secret: make sure no cache keeps it.
    const res = created<CreatedApiKey>(result, `/api/api-keys/${result.key.id}`);
    res.headers.set('cache-control', 'no-store');
    return res;
  };
  const revoke: Handler = (ctx) => {
    if (!ctx.params.id) throw errors.notFound();
    return ok<ApiKeyInfo>(apiKeys.revoke(actor(ctx), ctx.params.id, { ip: ctx.ip, requestId: ctx.requestId }));
  };
  const update: Handler = async (ctx) => {
    if (!ctx.params.id) throw errors.notFound();
    const body = await readJson(ctx, updateKeyBody);
    return ok<ApiKeyInfo>(apiKeys.update(actor(ctx), ctx.params.id, body, { ip: ctx.ip, requestId: ctx.requestId }));
  };
  return { list, beyondLifetime, create, update, revoke };
}
