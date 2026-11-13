import { errors } from '@clawrouter/core';
import type { SettingsService } from '@clawrouter/settings';
import type { SettingInfo } from '@clawrouter/shared';
import { readJson } from '../http/body.ts';
import type { Handler } from '../http/context.ts';
import { ok } from '../http/responses.ts';

/** `{ values: { key: number | null } }`: shape only; the service checks keys and ranges. */
const updateBody = (value: unknown, path: string, issues: { path: string; message: string }[]) => {
  const values = (value as { values?: unknown } | null)?.values;
  if (typeof value !== 'object' || value === null || Object.keys(value).some((k) => k !== 'values')
    || typeof values !== 'object' || values === null || Array.isArray(values) || Object.keys(values).length > 50) {
    issues.push({ path: path || 'values', message: 'must be an object of setting values' });
    return undefined;
  }
  return values as Record<string, unknown>;
};

/** System and security settings (settings.read / settings.write). */
export function settingsController(settings: SettingsService) {
  const list: Handler = () => ok<SettingInfo[]>(settings.list());

  const update: Handler = async (ctx) => {
    if (!ctx.auth) throw errors.notFound();
    const values = await readJson(ctx, updateBody);
    return ok<SettingInfo[]>(settings.update({ id: ctx.auth.user.id, username: ctx.auth.user.username }, values, { ip: ctx.ip, requestId: ctx.requestId }));
  };

  return { list, update };
}
