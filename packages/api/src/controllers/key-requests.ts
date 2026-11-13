import { errors, v } from '@clawrouter/core';
import type { ApiKeyService, KeyRequestService } from '@clawrouter/gateway';
import { KEY_REQUEST_STATUSES, type ApiKeyInfo, type ApiKeyRequestInfo, type CreatedApiKey, type KeyRequestStatus } from '@clawrouter/shared';
import { readJson } from '../http/body.ts';
import type { Handler, RequestContext } from '../http/context.ts';
import { created, ok } from '../http/responses.ts';
import { expiryField, modelList } from './gateway.ts';

/** A user's own key: no rate limit field (limits are set by administrators). */
const ownKeyBody = v.object({
  name: v.string({ min: 1, max: 100 }),
  allowedModels: modelList,
  expiry: expiryField,
});

const requestBody = v.object({
  name: v.string({ min: 1, max: 100 }),
  purpose: v.string({ min: 1, max: 500 }),
  allowedModels: modelList,
  expiry: expiryField,
});

const approveBody = v.object({
  allowedModels: modelList,
  expiry: expiryField,
  note: v.optional(v.string({ max: 500 })),
});

const denyBody = v.object({ reason: v.string({ min: 1, max: 500 }) });

const client = (ctx: RequestContext) => ({ ip: ctx.ip, requestId: ctx.requestId });
const actor = (ctx: RequestContext) => ({ id: ctx.auth!.user.id, username: ctx.auth!.user.username, permissions: ctx.auth!.permissions as ReadonlySet<string> });

/** Secrets must not be cached anywhere on the way. */
const withSecret = (res: Response) => {
  res.headers.set('cache-control', 'no-store');
  return res;
};

function pageQuery(url: URL) {
  const int = (name: string, fallback: number, max: number) => {
    const raw = url.searchParams.get(name);
    const n = raw ? Number(raw) : fallback;
    if (!Number.isInteger(n) || n < 1 || n > max) throw errors.validation([{ path: name, message: `must be an integer between 1 and ${max}` }]);
    return n;
  };
  const status = url.searchParams.get('status') || undefined;
  if (status && !(KEY_REQUEST_STATUSES as readonly string[]).includes(status)) throw errors.validation([{ path: 'status', message: `must be one of ${KEY_REQUEST_STATUSES.join(', ')}` }]);
  return { page: int('page', 1, 1_000_000), pageSize: int('pageSize', 25, 100), status: status as KeyRequestStatus | undefined };
}

/**
 * Self-service API keys and key requests.
 * - `/api/me/api-keys`: your own keys (create needs `api_keys.own`; anyone may list and revoke their own).
 * - `/api/me/api-key-requests`: ask for a key, cancel, and create it once approved.
 * - `/api/api-key-requests`: approvers (`api_keys.write`) list, approve and deny.
 */
export function keyRequestsController(apiKeys: ApiKeyService, requests: KeyRequestService) {
  return {
    listOwnKeys: ((ctx) => ok<ApiKeyInfo[]>(apiKeys.listOwned(ctx.auth!.user.id))) satisfies Handler,

    createOwnKey: (async (ctx) => {
      const body = await readJson(ctx, ownKeyBody);
      const result = apiKeys.create(actor(ctx), body, client(ctx));
      return withSecret(created<CreatedApiKey>(result, `/api/me/api-keys/${result.key.id}`));
    }) satisfies Handler,

    revokeOwnKey: ((ctx) => ok<ApiKeyInfo>(apiKeys.revokeOwned(actor(ctx), ctx.params.id ?? '', client(ctx)))) satisfies Handler,

    listMyRequests: ((ctx) => ok<ApiKeyRequestInfo[]>(requests.listMine(actor(ctx)))) satisfies Handler,

    submit: (async (ctx) => {
      const body = await readJson(ctx, requestBody);
      const r = requests.submit(actor(ctx), body, client(ctx));
      return created<ApiKeyRequestInfo>(r, `/api/me/api-key-requests/${r.id}`);
    }) satisfies Handler,

    cancel: ((ctx) => ok<ApiKeyRequestInfo>(requests.cancel(actor(ctx), ctx.params.id ?? '', client(ctx)))) satisfies Handler,

    fulfil: ((ctx) => {
      const result = requests.fulfil(actor(ctx), ctx.params.id ?? '', client(ctx));
      return withSecret(created<CreatedApiKey & { request: ApiKeyRequestInfo }>(result, `/api/me/api-keys/${result.key.id}`));
    }) satisfies Handler,

    list: ((ctx) => {
      const q = pageQuery(ctx.url);
      const { items, total } = requests.list(actor(ctx), q);
      return ok<ApiKeyRequestInfo[]>(items, { meta: { page: q.page, pageSize: q.pageSize, total } });
    }) satisfies Handler,

    approve: (async (ctx) => {
      const body = await readJson(ctx, approveBody);
      return ok<ApiKeyRequestInfo>(requests.approve(actor(ctx), ctx.params.id ?? '', body, client(ctx)));
    }) satisfies Handler,

    deny: (async (ctx) => {
      const body = await readJson(ctx, denyBody);
      return ok<ApiKeyRequestInfo>(requests.deny(actor(ctx), ctx.params.id ?? '', body, client(ctx)));
    }) satisfies Handler,
  };
}
