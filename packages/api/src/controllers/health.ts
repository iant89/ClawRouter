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
import type { HealthHistoryService, HealthService } from '@clawrouter/health';
import { HEALTH_COMPONENTS, type HealthComponent, type HealthHistoryReport, type HealthReport } from '@clawrouter/shared';
import type { Handler } from '../http/context.ts';
import { ok } from '../http/responses.ts';

/**
 * GET /api/health: overall platform health. Public, so load balancers can use it
 * (HTTP 503 when OFFLINE). Callers without `health.read` (anonymous ones
 * included) get statuses only: details and latencies describe traffic and
 * infrastructure, which is not for everyone.
 */
export function healthHandler(health: HealthService): Handler {
  return async (ctx) => {
    const report = await health.report();
    const full = ctx.auth?.permissions.has('health.read') ?? false;
    const body: HealthReport = full ? report : { ...report, checks: report.checks.map(({ component, status, critical, checkedAt }) => ({ component, status, critical, checkedAt, latencyMs: 0 })) };
    return ok(body, { status: report.status === 'OFFLINE' ? 503 : 200 });
  };
}

/** GET /api/health/history?hours=24&component=gateway (spec §24 health history). */
export function healthHistoryHandler(history: HealthHistoryService): Handler {
  return (ctx) => {
    const rawHours = ctx.url.searchParams.get('hours');
    const hours = rawHours === null || rawHours === '' ? undefined : Number(rawHours);
    const component = ctx.url.searchParams.get('component') || undefined;
    if (component !== undefined && !(HEALTH_COMPONENTS as readonly string[]).includes(component)) {
      throw errors.validation([{ path: 'component', message: `must be one of ${HEALTH_COMPONENTS.join(', ')}` }]);
    }
    return ok<HealthHistoryReport>(history.report({ hours, component: component as HealthComponent | undefined }));
  };
}

/** Where the process is in its life: serving, or finishing in-flight work before it stops. */
export interface Lifecycle {
  state(): 'ready' | 'draining';
}

/**
 * GET /api/health/live and /api/health/ready (phase 17), public for load
 * balancers and orchestrators. Live: the process answers. Ready: it should get
 * traffic; 503 while it drains for a shutdown or restart. Neither says more.
 */
export function livenessHandler(): Handler {
  return () => ok({ status: 'alive' });
}

export function readinessHandler(lifecycle: Lifecycle | undefined): Handler {
  return () => {
    const state = lifecycle?.state() ?? 'ready';
    return state === 'ready'
      ? ok({ status: 'ready' })
      : new Response(JSON.stringify({ data: { status: state } }), { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '5', 'cache-control': 'no-store' } });
  };
}
