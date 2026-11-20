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
  const preview: Handler = async (ctx) => ok<ImportPlan>(configuration.plan(actor(ctx), await readJsonValue(ctx, IMPORT_BODY_LIMIT)));
  const apply: Handler = async (ctx) => ok<ImportResult>(await configuration.apply(actor(ctx), await readJsonValue(ctx, IMPORT_BODY_LIMIT), client(ctx)));
  return { export: exportHandler, preview, apply };
}
