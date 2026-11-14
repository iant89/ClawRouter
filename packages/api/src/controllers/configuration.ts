import type { ConfigurationService } from '@clawrouter/configuration';
import type { ConfigurationDocument, ImportPlan, ImportResult } from '@clawrouter/shared';
import { readJsonValue } from '../http/body.ts';
import type { Handler, RequestContext } from '../http/context.ts';
import { ok } from '../http/responses.ts';

/** A configuration with thousands of models runs to a few megabytes. */
const IMPORT_BODY_LIMIT = 20 * 1024 * 1024;

const actor = (ctx: RequestContext) => ({ id: ctx.auth!.user.id, username: ctx.auth!.user.username, permissions: ctx.auth!.permissions as ReadonlySet<string> });
const client = (ctx: RequestContext) => ({ ip: ctx.ip, userAgent: ctx.request.headers.get('user-agent'), requestId: ctx.requestId });

/** /api/configuration (phase 17): export, and import with a preview first. */
export function configurationController(configuration: ConfigurationService) {
  const exportHandler: Handler = (ctx) => {
    const res = ok<ConfigurationDocument>(configuration.export(actor(ctx), client(ctx)));
    res.headers.set('cache-control', 'no-store');
    return res;
  };
  const preview: Handler = async (ctx) => ok<ImportPlan>(configuration.plan(actor(ctx), configuration.parse(await readJsonValue(ctx, IMPORT_BODY_LIMIT))));
  const apply: Handler = async (ctx) => ok<ImportResult>(await configuration.apply(actor(ctx), configuration.parse(await readJsonValue(ctx, IMPORT_BODY_LIMIT)), client(ctx)));
  return { export: exportHandler, preview, apply };
}
