import { errors } from '@clawrouter/core';
import type { AuditService } from '@clawrouter/audit';
import { AUDIT_ACTIONS, type AuditAction, type AuditRecord, type AuditResult } from '@clawrouter/shared';
import type { Handler } from '../http/context.ts';
import { ok } from '../http/responses.ts';

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw errors.validation([{ path: name, message: `must be an integer between ${min} and ${max}` }]);
  return n;
}

function text(url: URL, name: string, max = 200): string | undefined {
  const v = url.searchParams.get(name)?.trim();
  if (!v) return undefined;
  if (v.length > max) throw errors.validation([{ path: name, message: `must be at most ${max} characters` }]);
  return v;
}

function iso(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name);
  if (!raw) return undefined;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) throw errors.validation([{ path: name, message: 'must be an ISO date-time' }]);
  return new Date(t).toISOString();
}

/**
 * GET /api/audit (spec §28, §31): the audit log, filtered and paged on the
 * server. `audit.read` is for administrators and operators only: records hold
 * client addresses and failed sign-ins. Metadata was redacted when written.
 */
export function auditController(audit: AuditService) {
  const list: Handler = (ctx) => {
    const url = ctx.url;
    const action = url.searchParams.get('action') || undefined;
    if (action && !(AUDIT_ACTIONS as readonly string[]).includes(action)) throw errors.validation([{ path: 'action', message: 'is not a known audit action' }]);
    const result = url.searchParams.get('result') || undefined;
    if (result && result !== 'SUCCESS' && result !== 'FAILURE') throw errors.validation([{ path: 'result', message: 'must be SUCCESS or FAILURE' }]);
    const r = audit.search({
      page: intParam(url, 'page', 1, 1, 1_000_000), pageSize: intParam(url, 'pageSize', 50, 1, 200),
      action: action as AuditAction | undefined, result: result as AuditResult | undefined,
      resource: text(url, 'resource', 64), resourceId: text(url, 'resourceId', 128), actor: text(url, 'actor', 64),
      requestId: text(url, 'requestId', 64), from: iso(url, 'from'), to: iso(url, 'to'), q: text(url, 'q'),
    });
    return ok<AuditRecord[]>(r.items, { meta: { page: r.page, pageSize: r.pageSize, total: r.total, resources: r.resources } });
  };
  return { list };
}
