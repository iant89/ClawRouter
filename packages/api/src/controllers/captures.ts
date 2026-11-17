import { MANUAL_LIMITS, type CaptureService } from '@clawrouter/captures';
import { errors, v, type Validator } from '@clawrouter/core';
import {
  CAPTURE_EXPORT_MAX, CAPTURE_TRIGGERS,
  type CaptureDetail, type CaptureState, type CaptureSummary, type CaptureTrigger, type ManualCaptureInfo,
} from '@clawrouter/shared';
import { readJson } from '../http/body.ts';
import type { Handler, RequestContext } from '../http/context.ts';
import { ok } from '../http/responses.ts';

const int = (min: number, max: number): Validator<number> => (value, path, issues) => {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
  issues.push({ path, message: value === undefined ? 'is required' : `must be a whole number from ${min} to ${max}` });
  return undefined;
};

const captureIds: Validator<string[]> = (value, path, issues) => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000 || !value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)) {
    issues.push({ path, message: 'must be a list of capture ids' });
    return undefined;
  }
  return value as string[];
};

const startBody = v.object({
  providerId: v.optional(v.string({ min: 1, max: 64 })),
  model: v.optional(v.string({ min: 1, max: 300 })),
  count: int(1, MANUAL_LIMITS.maxCount),
  minutes: int(1, MANUAL_LIMITS.maxMinutes),
});
const exportBody = v.object({
  ids: (value, path, issues) => {
    const ids = captureIds(value, path, issues);
    if (ids && ids.length > CAPTURE_EXPORT_MAX) {
      issues.push({ path, message: `at most ${CAPTURE_EXPORT_MAX} captures per export` });
      return undefined;
    }
    return ids;
  },
  maskText: v.boolean(),
});
const deleteBody = v.object({ ids: v.optional(captureIds), all: v.optional(v.boolean()) });

const actor = (ctx: RequestContext) => ({ id: ctx.auth!.user.id, username: ctx.auth!.user.username });
const client = (ctx: RequestContext) => ({ ip: ctx.ip, requestId: ctx.requestId });

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw errors.validation([{ path: name, message: `must be an integer between ${min} and ${max}` }]);
  return n;
}

/** /api/captures (captures.manage): provider captures, owner request 2026-11-17. */
export function capturesController(captures: CaptureService) {
  const state: Handler = () => ok<CaptureState>(captures.state());

  const list: Handler = (ctx) => {
    const url = ctx.url;
    const page = intParam(url, 'page', 1, 1, 1_000_000);
    const pageSize = intParam(url, 'pageSize', 50, 1, 200);
    const trigger = url.searchParams.get('trigger') || undefined;
    if (trigger && !(CAPTURE_TRIGGERS as readonly string[]).includes(trigger)) throw errors.validation([{ path: 'trigger', message: `must be one of ${CAPTURE_TRIGGERS.join(', ')}` }]);
    const providerId = url.searchParams.get('providerId')?.slice(0, 64) || undefined;
    const result = captures.list({ trigger: trigger as CaptureTrigger | undefined, providerId, limit: pageSize, offset: (page - 1) * pageSize });
    return ok<CaptureSummary[]>(result.items, { meta: { page, pageSize, total: result.total } });
  };

  const get: Handler = (ctx) => {
    if (!ctx.params.id) throw errors.notFound();
    const res = ok<CaptureDetail>(captures.get(ctx.params.id));
    res.headers.set('cache-control', 'no-store');
    return res;
  };

  const startManual: Handler = async (ctx) => {
    const body = await readJson(ctx, startBody);
    return ok<ManualCaptureInfo>(captures.startManual(actor(ctx), { providerId: body.providerId ?? null, model: body.model ?? null, count: body.count, minutes: body.minutes }, client(ctx)));
  };

  const stopManual: Handler = (ctx) => {
    captures.stopManual(actor(ctx), client(ctx));
    return ok<CaptureState>(captures.state());
  };

  /** Deletes the listed captures, or every capture with `{ all: true }`. */
  const remove: Handler = async (ctx) => {
    const body = await readJson(ctx, deleteBody);
    if (!body.all && !body.ids) throw errors.validation([{ path: 'ids', message: 'list the captures to delete, or send all: true' }]);
    const deleted = captures.delete(actor(ctx), body.all ? 'all' : body.ids!, client(ctx));
    return ok({ deleted });
  };

  /** The file for a developer, as a download. */
  const exportHandler: Handler = async (ctx) => {
    const body = await readJson(ctx, exportBody);
    const file = captures.export(actor(ctx), body.ids, body.maskText, client(ctx));
    const stamp = file.exportedAt.replace(/[:.]/g, '-').slice(0, 19);
    return new Response(JSON.stringify(file, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="clawrouter-capture-${stamp}${file.masked ? '-masked' : ''}.json"`,
        'cache-control': 'no-store',
      },
    });
  };

  return { state, list, get, startManual, stopManual, remove, export: exportHandler };
}
