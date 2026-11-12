import type { Validator } from '@clawrouter/core';
import type { RateLimitService } from '@clawrouter/rate-limits';
import type { PutRateLimitsRequest, RateLimitConfigView, RateLimitUsage } from '@clawrouter/shared';
import { readJson } from '../http/body.ts';
import type { Handler, RequestContext } from '../http/context.ts';
import { ok } from '../http/responses.ts';

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const FIELDS = ['version', 'perKey', 'perUser', 'perModel', 'global', 'invalidKeysPerIp'];

/** Shape only; the rate-limit service validates every value (ranges, model references). */
const putBody: Validator<PutRateLimitsRequest> = (value, _path, issues) => {
  if (!isObject(value)) {
    issues.push({ path: '(body)', message: 'must be an object' });
    return undefined;
  }
  const before = issues.length;
  for (const key of Object.keys(value)) if (!FIELDS.includes(key)) issues.push({ path: key, message: 'is not allowed' });
  for (const key of FIELDS) if (!(key in value)) issues.push({ path: key, message: 'is required' });
  if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 0) issues.push({ path: 'version', message: 'must be the version you loaded' });
  if (issues.length !== before) return undefined;
  return value as unknown as PutRateLimitsRequest;
};

const actor = (ctx: RequestContext) => ({ id: ctx.auth!.user.id, username: ctx.auth!.user.username });

/** /api/rate-limits (spec §12, §31): the configuration and live usage against it. */
export function rateLimitsController(limits: RateLimitService) {
  const get: Handler = () => ok<RateLimitConfigView>(limits.get());
  const put: Handler = async (ctx) => {
    const body = await readJson(ctx, putBody, 256 * 1024);
    return ok<RateLimitConfigView>(limits.update(actor(ctx), body, { ip: ctx.ip, requestId: ctx.requestId }));
  };
  // Client addresses are personal data: only users who may read the audit log see them (Viewers do not).
  const usage: Handler = async (ctx) => {
    const result = await limits.usage();
    if (ctx.auth?.permissions.has('audit.read')) return ok<RateLimitUsage>(result);
    let n = 0;
    const masked = result.entries.map((e) => (e.scope === 'ip' ? { ...e, subject: `hidden-${(n += 1)}`, label: '(hidden)' } : e));
    return ok<RateLimitUsage>({ ...result, entries: masked });
  };
  return { get, put, usage };
}
