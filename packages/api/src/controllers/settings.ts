/*
 * ClawRouter - Self-hosted AI gateway and control platform
 * https://github.com/iant89/ClawRouter
 *
 * Copyright (C) 2026 Ian Thomas
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * in the LICENSE file for more details.
 */

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
