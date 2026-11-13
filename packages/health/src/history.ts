import { errors, type Logger } from '@clawrouter/core';
import type { Database } from '@clawrouter/database';
import {
  HEALTH_COMPONENTS, HEALTH_SEVERITY, type ComponentHistory, type HealthComponent, type HealthHistoryReport, type HealthReport, type HealthState,
} from '@clawrouter/shared';

/** Storage for scheduled health check results (spec §24 health history). */
export interface HealthHistoryRepository {
  insert(rows: { checkedAt: string; component: string; status: HealthState; latencyMs: number; detail: string | null }[]): void;
  /** Rows for the period, oldest first. */
  between(from: string, to: string, component?: string): { checked_at: string; component: string; status: HealthState; latency_ms: number; detail: string | null }[];
  prune(before: string): number;
}

export function createSqliteHealthHistoryRepository(db: Database): HealthHistoryRepository {
  return {
    insert(rows) {
      db.transaction((tx) => {
        for (const r of rows) {
          tx.run('INSERT INTO health_history (checked_at, component, status, latency_ms, detail) VALUES (?, ?, ?, ?, ?)', [r.checkedAt, r.component, r.status, r.latencyMs, r.detail]);
        }
      });
    },
    between(from, to, component) {
      return db.all(
        `SELECT checked_at, component, status, latency_ms, detail FROM health_history
         WHERE checked_at >= ? AND checked_at < ? ${component ? 'AND component = ?' : ''} ORDER BY checked_at, id`,
        component ? [from, to, component] : [from, to],
      );
    },
    prune: (before) => db.run('DELETE FROM health_history WHERE checked_at < ?', [before]).changes,
  };
}

const BUCKETS = 48;
export const MAX_HISTORY_HOURS = 7 * 24;

export type HealthHistoryService = ReturnType<typeof createHealthHistoryService>;

/**
 * Health history: the server records every scheduled health report (not the
 * ones requested through the API, so history has a regular rhythm), and reports
 * availability, a bucketed timeline and status changes per component.
 */
export function createHealthHistoryService(options: { repo: HealthHistoryRepository; log?: Logger; now?: () => Date; retentionDays?: number }) {
  const { repo, log } = options;
  const now = options.now ?? (() => new Date());
  const retentionDays = options.retentionDays ?? 7;

  return {
    record(report: HealthReport) {
      try {
        repo.insert(report.checks.map((c) => ({ checkedAt: c.checkedAt, component: c.component, status: c.status, latencyMs: c.latencyMs, detail: c.detail ?? null })));
      } catch (error) {
        log?.error('could not record health history', { component: 'health', error });
      }
    },

    report(q: { hours?: number; component?: HealthComponent } = {}): HealthHistoryReport {
      const hours = q.hours ?? 24;
      if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HISTORY_HOURS) throw errors.validation([{ path: 'hours', message: `must be a whole number from 1 to ${MAX_HISTORY_HOURS}` }]);
      const bucketMs = Math.max(60_000, Math.round((hours * 3_600_000) / BUCKETS / 60_000) * 60_000);
      const end = now().getTime();
      const to = Math.floor(end / bucketMs) * bucketMs + bucketMs;
      const from = to - bucketMs * BUCKETS;
      const rows = repo.between(new Date(from).toISOString(), new Date(to).toISOString(), q.component);

      const byComponent = new Map<string, typeof rows>();
      for (const r of rows) byComponent.set(r.component, [...(byComponent.get(r.component) ?? []), r]);
      const components = (q.component ? [q.component] : HEALTH_COMPONENTS.filter((c) => byComponent.has(c))).map((component): ComponentHistory => {
        const list = byComponent.get(component) ?? [];
        const counted = list.filter((r) => r.status !== 'DISABLED');
        const buckets = Array.from({ length: BUCKETS }, (_, i) => ({ start: new Date(from + i * bucketMs).toISOString(), status: null as HealthState | null, checks: 0 }));
        const changes: ComponentHistory['changes'] = [];
        let previous: HealthState | null = null;
        for (const r of list) {
          const b = buckets[Math.min(BUCKETS - 1, Math.floor((Date.parse(r.checked_at) - from) / bucketMs))]!;
          b.checks += 1;
          if (b.status === null || HEALTH_SEVERITY[r.status] > HEALTH_SEVERITY[b.status]) b.status = r.status;
          if (r.status !== previous) changes.push({ at: r.checked_at, from: previous, to: r.status, detail: r.detail });
          previous = r.status;
        }
        return {
          component,
          current: list.at(-1)?.status ?? null,
          availability: counted.length ? Math.round((counted.filter((r) => r.status === 'HEALTHY').length / counted.length) * 10_000) / 10_000 : null,
          checks: list.length,
          averageLatencyMs: list.length ? Math.round(list.reduce((s, r) => s + r.latency_ms, 0) / list.length) : null,
          buckets,
          changes: changes.reverse().slice(0, 50),
        };
      });
      return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), bucketMinutes: bucketMs / 60_000, components };
    },

    prune(): number {
      if (retentionDays <= 0) return 0;
      return repo.prune(new Date(now().getTime() - retentionDays * 86_400_000).toISOString());
    },
  };
}
