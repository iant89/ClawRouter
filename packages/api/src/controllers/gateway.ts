import { AppError, errors, v } from '@clawrouter/core';
import type { ApiKeyService, GatewayResult, GatewayService } from '@clawrouter/gateway';
import type { ApiKeyInfo, CreatedApiKey, GatewayMetrics } from '@clawrouter/shared';
import { readJson } from '../http/body.ts';
import type { Handler, RequestContext } from '../http/context.ts';
import { created, json, ok } from '../http/responses.ts';

/** Chat requests can carry long conversations. */
const GATEWAY_BODY_LIMIT = 10 * 1024 * 1024;

/** Reads a JSON body for /v1 without imposing a schema: the gateway validates it in OpenAI terms. */
async function readGatewayBody(ctx: RequestContext): Promise<unknown> {
  const type = ctx.request.headers.get('content-type') ?? '';
  if (!/^application\/json(\s*;|$)/i.test(type)) throw new AppError('VALIDATION_ERROR', 'Content-Type must be application/json.');
  const declared = Number(ctx.request.headers.get('content-length') ?? '0');
  if (declared > GATEWAY_BODY_LIMIT) throw new AppError('VALIDATION_ERROR', 'Request body is too large (limit 10 MB).');
  const text = await ctx.request.text();
  if (text.length > GATEWAY_BODY_LIMIT) throw new AppError('VALIDATION_ERROR', 'Request body is too large (limit 10 MB).');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Request body is not valid JSON.');
  }
}

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

const createKeyBody = v.object({
  name: v.string({ min: 1, max: 100 }),
  allowedModels: v.optional<string[]>((value, path, issues) => {
    if (Array.isArray(value) && value.every((m) => typeof m === 'string')) return value as string[];
    issues.push({ path, message: 'must be a list of model names' });
    return undefined;
  }),
  expiresAt: (value, path, issues) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string') return value;
    issues.push({ path, message: 'must be an ISO date-time or null' });
    return undefined;
  },
});

const actor = (ctx: RequestContext) => ({ id: ctx.auth!.user.id, username: ctx.auth!.user.username });

/** /api/api-keys (spec §31): create (the only time the key is shown), list, revoke. */
export function apiKeysController(apiKeys: ApiKeyService) {
  const list: Handler = () => ok<ApiKeyInfo[]>(apiKeys.list());
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
  return { list, create, revoke };
}
