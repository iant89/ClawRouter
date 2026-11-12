import type { HealthService } from '@clawapi/health';
import type { Handler } from '../http/context.ts';
import { ok } from '../http/responses.ts';

/**
 * GET /api/health — overall platform health. Public in the first milestone
 * (no secrets, no config values). HTTP 503 when OFFLINE so load balancers can act.
 */
export function healthHandler(health: HealthService): Handler {
  return async () => {
    const report = await health.report();
    return ok(report, { status: report.status === 'OFFLINE' ? 503 : 200 });
  };
}
