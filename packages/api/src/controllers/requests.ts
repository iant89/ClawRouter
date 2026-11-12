import { errors } from '@clawrouter/core';
import type { RequestLogService } from '@clawrouter/requests';
import {
  REQUEST_STATUSES, USAGE_GROUPS, type RequestDetail, type RequestRecord, type RequestStatus, type UsageGroup, type UsageReport,
} from '@clawrouter/shared';
import type { Handler } from '../http/context.ts';
import { ok } from '../http/responses.ts';

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw errors.validation([{ path: name, message: `must be an integer between ${min} and ${max}` }]);
  return n;
}

function oneOf<T extends string>(url: URL, name: string, allowed: readonly T[]): T | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return undefined;
  if (!(allowed as readonly string[]).includes(raw)) throw errors.validation([{ path: name, message: `must be one of ${allowed.join(', ')}` }]);
  return raw as T;
}

function isoParam(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return undefined;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) throw errors.validation([{ path: name, message: 'must be an ISO date-time' }]);
  return new Date(t).toISOString();
}

function textParam(url: URL, name: string, max = 300): string | undefined {
  const raw = url.searchParams.get(name)?.trim();
  if (!raw) return undefined;
  if (raw.length > max) throw errors.validation([{ path: name, message: `must be at most ${max} characters` }]);
  return raw;
}

/** /api/requests and /api/usage (spec §22, §23, §31). Filtering and paging happen on the server. */
export function requestsController(requests: RequestLogService) {
  const list: Handler = (ctx) => {
    const url = ctx.url;
    const result = requests.list({
      page: intParam(url, 'page', 1, 1, 1_000_000),
      pageSize: intParam(url, 'pageSize', 50, 1, 200),
      status: oneOf<RequestStatus>(url, 'status', REQUEST_STATUSES),
      apiKeyId: textParam(url, 'apiKeyId', 64),
      providerId: textParam(url, 'providerId', 64),
      model: textParam(url, 'model'),
      from: isoParam(url, 'from'),
      to: isoParam(url, 'to'),
      problemsOnly: url.searchParams.get('problems') === 'true',
    });
    return ok<RequestRecord[]>(result.items, { meta: { page: result.page, pageSize: result.pageSize, total: result.total } });
  };

  const get: Handler = (ctx) => {
    if (!ctx.params.id) throw errors.notFound();
    return ok<RequestDetail>(requests.get(ctx.params.id));
  };

  const usage: Handler = (ctx) => {
    const url = ctx.url;
    return ok<UsageReport>(requests.usage({
      from: isoParam(url, 'from'),
      to: isoParam(url, 'to'),
      bucket: oneOf(url, 'bucket', ['hour', 'day'] as const),
      groupBy: oneOf<UsageGroup>(url, 'groupBy', USAGE_GROUPS),
    }));
  };

  return { list, get, usage };
}
