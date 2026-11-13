import { errors, type LogBuffer } from '@clawrouter/core';
import { LOG_LEVEL_NAMES, type LogLevelName, type LogPage } from '@clawrouter/shared';
import type { Handler } from '../http/context.ts';
import { ok } from '../http/responses.ts';

const text = (url: URL, name: string, max = 200) => {
  const v = url.searchParams.get(name)?.trim();
  if (!v) return undefined;
  if (v.length > max) throw errors.validation([{ path: name, message: `must be at most ${max} characters` }]);
  return v;
};

const seq = (url: URL, name: string) => {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw errors.validation([{ path: name, message: 'must be a sequence number' }]);
  return n;
};

/**
 * GET /api/logs (spec §27): recent server log records, filtered on the server.
 * Records are redacted when they are written; `logs.read` is for administrators
 * and operators only, because records include client addresses.
 */
export function logsController(buffer: LogBuffer | null) {
  const list: Handler = (ctx) => {
    const url = ctx.url;
    const level = url.searchParams.get('level') || undefined;
    if (level && !(LOG_LEVEL_NAMES as readonly string[]).includes(level)) throw errors.validation([{ path: 'level', message: `must be one of ${LOG_LEVEL_NAMES.join(', ')}` }]);
    const limitRaw = seq(url, 'limit');
    if (!buffer) return ok<LogPage>({ items: [], hasOlder: false, latestSeq: 0, oldestTime: null, capacity: 0, components: [] });
    return ok<LogPage>(buffer.query({
      level: level as LogLevelName | undefined,
      component: text(url, 'component', 64), requestId: text(url, 'requestId', 64), providerId: text(url, 'providerId', 64), userId: text(url, 'userId', 64),
      q: text(url, 'q'), before: seq(url, 'before'), after: seq(url, 'after'), limit: limitRaw,
    }));
  };
  return { list };
}
