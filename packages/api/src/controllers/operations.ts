import { errors, v, type Validator } from '@clawrouter/core';
import type { OperationService } from '@clawrouter/operations';
import { isOperationType, OPERATION_STATUSES, type OperationInfo, type OperationStatus, type OperationType } from '@clawrouter/shared';
import { readJson } from '../http/body.ts';
import type { Handler, RequestContext } from '../http/context.ts';
import { created, ok } from '../http/responses.ts';

const startBody = v.object({
  type: ((value, path, issues) => {
    if (isOperationType(value)) return value;
    issues.push({ path, message: 'is not a known operation type' });
    return undefined;
  }) as Validator<OperationType>,
  targetId: v.optional(v.string({ min: 1, max: 64 })),
});

/** The signed-in user as an operations actor (permissions decide per operation type). */
const actor = (ctx: RequestContext) => ({ id: ctx.auth!.user.id, username: ctx.auth!.user.username, permissions: ctx.auth!.permissions as ReadonlySet<string> });
const client = (ctx: RequestContext) => ({ ip: ctx.ip, requestId: ctx.requestId });

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw errors.validation([{ path: name, message: `must be an integer between ${min} and ${max}` }]);
  return n;
}

/**
 * /api/operations (spec §26). The routes are 'authenticated': which operations a
 * user may see, start or cancel depends on the operation type (OPERATION_TYPES),
 * and the operation service enforces it on every call.
 */
export function operationsController(operations: OperationService) {
  const list: Handler = (ctx) => {
    const url = ctx.url;
    const status = url.searchParams.get('status') || undefined;
    const type = url.searchParams.get('type') || undefined;
    if (status && !(OPERATION_STATUSES as readonly string[]).includes(status)) throw errors.validation([{ path: 'status', message: `must be one of ${OPERATION_STATUSES.join(', ')}` }]);
    if (type && !isOperationType(type)) throw errors.validation([{ path: 'type', message: 'is not a known operation type' }]);
    const r = operations.list(actor(ctx), {
      page: intParam(url, 'page', 1, 1, 1_000_000), pageSize: intParam(url, 'pageSize', 50, 1, 200),
      status: status as OperationStatus | undefined, type: type as OperationType | undefined,
    });
    return ok<OperationInfo[]>(r.items, { meta: { page: r.page, pageSize: r.pageSize, total: r.total } });
  };

  const get: Handler = (ctx) => ok<OperationInfo>(operations.get(actor(ctx), ctx.params.id ?? ''));

  const start: Handler = async (ctx) => {
    const body = await readJson(ctx, startBody);
    const op = operations.start(actor(ctx), { type: body.type, targetId: body.targetId ?? null }, client(ctx));
    return created<OperationInfo>(op, `/api/operations/${op.id}`);
  };

  const cancel: Handler = (ctx) => ok<OperationInfo>(operations.cancel(actor(ctx), ctx.params.id ?? '', client(ctx)));

  return { list, get, start, cancel };
}
