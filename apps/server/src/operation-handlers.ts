import { AppError } from '@clawrouter/core';
import type { HealthService } from '@clawrouter/health';
import type { OperationHandler } from '@clawrouter/operations';
import type { ProviderService } from '@clawrouter/providers';
import type { ConnectionTestResult, OperationType } from '@clawrouter/shared';

/**
 * The work behind each operation type (spec §26). Defined here, where providers
 * and health are wired together, so the operations package depends on neither.
 */
export function operationHandlers(deps: { providers: ProviderService; health: HealthService }): Record<OperationType, OperationHandler> {
  const { providers, health } = deps;
  const actorOf = (a: { id: string; username: string }) => ({ id: a.id, username: a.username });
  const nameOf = (id: string) => {
    try {
      return providers.get(id).name;
    } catch {
      return null;
    }
  };

  return {
    'provider.test': {
      timeoutMs: 60_000,
      validateTarget: (id) => void providers.get(id),
      describeTarget: nameOf,
      async run(ctx) {
        ctx.progress(10, 'Contacting the provider');
        const r: ConnectionTestResult = await providers.test(actorOf(ctx.actor), ctx.targetId!, { ip: null });
        return { result: r, message: r.message, ok: r.ok };
      },
    },

    'providers.check': {
      timeoutMs: 5 * 60_000,
      async run(ctx) {
        const enabled = providers.list().filter((p) => p.enabled);
        const failed: { id: string; name: string; message: string }[] = [];
        for (const [i, p] of enabled.entries()) {
          if (ctx.signal.aborted) throw new AppError('CONFLICT', 'Cancelled.');
          ctx.progress((i / Math.max(1, enabled.length)) * 100, `Testing ${p.name} (${i + 1} of ${enabled.length})`);
          const r = await providers.test(actorOf(ctx.actor), p.id, { ip: null });
          if (!r.ok) failed.push({ id: p.id, name: p.name, message: r.message });
        }
        const healthy = enabled.length - failed.length;
        return {
          result: { checked: enabled.length, healthy, failed },
          message: enabled.length ? `${healthy} of ${enabled.length} enabled provider(s) reachable` : 'No providers are enabled',
        };
      },
    },

    'health.check': {
      timeoutMs: 30_000,
      async run(ctx) {
        ctx.progress(20, 'Checking every component');
        const report = await health.report();
        return {
          result: { status: report.status, checks: report.checks.map((c) => ({ component: c.component, status: c.status, detail: c.detail ?? null })) },
          message: `Platform ${report.status.toLowerCase()}`,
        };
      },
    },
  };
}
