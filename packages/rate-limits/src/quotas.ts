import { AppError, errors, fromWallTime, isTimeZone, wallTime, type EventBus, type Logger } from '@clawrouter/core';
import type { AuditService } from '@clawrouter/audit';
import type { Database } from '@clawrouter/database';
import {
  QUOTA_AMOUNT_MAX, QUOTA_PERIODS, QUOTA_UNITS,
  type FieldIssue, type QuotaPeriod, type QuotaUnit, type QuotaUsage, type UserQuota, type UserQuotaView,
} from '@clawrouter/shared';

/** Persistence for user quotas: one JSON document per user. */
export interface QuotaStore {
  all(): Map<string, UserQuota>;
  set(userId: string, quota: UserQuota | null, at: string, by: string | null): void;
}

export function createSqliteQuotaStore(db: Database): QuotaStore {
  return {
    all() {
      const rows = db.all<{ user_id: string; quota: string }>('SELECT user_id, quota FROM user_quotas');
      return new Map(rows.map((r) => [r.user_id, JSON.parse(r.quota) as UserQuota]));
    },
    set(userId, quota, at, by) {
      if (!quota) db.run('DELETE FROM user_quotas WHERE user_id = ?', [userId]);
      else {
        db.run(
          `INSERT INTO user_quotas (user_id, quota, updated_at, updated_by) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET quota = excluded.quota, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          [userId, JSON.stringify(quota), at, by],
        );
      }
    },
  };
}

const QUOTA_FIELDS = new Set(['unit', 'amount', 'period', 'resetHour', 'resetWeekday', 'resetDayOfMonth', 'timeZone']);

function whole(v: unknown, path: string, min: number, max: number, issues: FieldIssue[]) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) issues.push({ path, message: `must be a whole number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}` });
}

/** Checks a quota sent by a client. Returns the normalized quota, or null with `issues` filled in. */
export function checkQuota(value: unknown, path: string, issues: FieldIssue[]): UserQuota | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push({ path, message: 'must be a quota object, or null for no quota' });
    return null;
  }
  const q = value as Record<string, unknown>;
  const before = issues.length;
  for (const k of Object.keys(q)) if (!QUOTA_FIELDS.has(k)) issues.push({ path: `${path}.${k}`, message: 'is not a quota field' });
  if (!QUOTA_UNITS.includes(q.unit as QuotaUnit)) issues.push({ path: `${path}.unit`, message: 'must be tokens, requests or cost' });
  if (q.unit === 'cost') {
    if (typeof q.amount !== 'number' || !Number.isFinite(q.amount) || q.amount < 0.01 || q.amount > 1_000_000_000) {
      issues.push({ path: `${path}.amount`, message: 'must be an amount in US dollars from 0.01 to 1,000,000,000' });
    }
  } else whole(q.amount, `${path}.amount`, 1, QUOTA_AMOUNT_MAX, issues);
  if (!QUOTA_PERIODS.includes(q.period as QuotaPeriod)) issues.push({ path: `${path}.period`, message: 'must be day, week or month' });
  whole(q.resetHour ?? 0, `${path}.resetHour`, 0, 23, issues);
  whole(q.resetWeekday ?? 1, `${path}.resetWeekday`, 1, 7, issues);
  whole(q.resetDayOfMonth ?? 1, `${path}.resetDayOfMonth`, 1, 28, issues);
  if (!isTimeZone(q.timeZone ?? 'UTC')) issues.push({ path: `${path}.timeZone`, message: 'must be an IANA time zone, e.g. Europe/London' });
  if (issues.length > before) return null;
  return {
    unit: q.unit as QuotaUnit,
    amount: q.unit === 'cost' ? Math.round((q.amount as number) * 100) / 100 : (q.amount as number),
    period: q.period as QuotaPeriod,
    resetHour: (q.resetHour as number | undefined) ?? 0,
    resetWeekday: (q.resetWeekday as number | undefined) ?? 1,
    resetDayOfMonth: (q.resetDayOfMonth as number | undefined) ?? 1,
    timeZone: (q.timeZone as string | undefined) ?? 'UTC',
  };
}

/** The period of `q` that contains `at`: when it started and when it resets. */
export function quotaPeriod(q: UserQuota, at: Date): { start: Date; end: Date } {
  const t = at.getTime();
  const w = wallTime(t, q.timeZone);
  const startOf = (y: number, m: number, d: number) => fromWallTime(y, m, d, q.resetHour, q.timeZone);
  let { year: y, month: m, day: d } = w;
  if (q.period === 'day') {
    if (startOf(y, m, d) > t) d -= 1;
    return { start: new Date(startOf(y, m, d)), end: new Date(startOf(y, m, d + 1)) };
  }
  if (q.period === 'week') {
    d -= (w.weekday - q.resetWeekday + 7) % 7;
    if (startOf(y, m, d) > t) d -= 7;
    return { start: new Date(startOf(y, m, d)), end: new Date(startOf(y, m, d + 7)) };
  }
  d = q.resetDayOfMonth;
  if (startOf(y, m, d) > t) m -= 1;
  return { start: new Date(startOf(y, m, d)), end: new Date(startOf(y, m + 1, d)) };
}

const PERIOD_WORDS: Record<QuotaPeriod, string> = { day: 'today', week: 'this week', month: 'this month' };

/** "1,000 tokens", "25 requests", "$12.50". */
export function formatQuotaAmount(unit: QuotaUnit, n: number): string {
  if (unit === 'cost') return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const v = Math.round(n).toLocaleString('en-US');
  return unit === 'tokens' ? `${v} tokens` : `${v} ${Math.round(n) === 1 ? 'request' : 'requests'}`;
}

function formatReset(at: Date, timeZone: string): string {
  const s = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  return `${s} (${timeZone})`;
}

/** What is needed to manage another user's quota. Implemented with the authorization rules. */
export interface QuotaAccess {
  /** The user's name, or null when there is no such user. */
  username(userId: string): string | null;
  /** Throws when the actor may not manage this user (they hold permissions the actor lacks). */
  assertCanManage(actor: QuotaActor, userId: string): void;
}

export interface QuotaActor {
  id: string;
  username: string;
  permissions: ReadonlySet<string>;
}

/** Totals for one user since an instant (from the request history's hourly records). */
export type QuotaUsageSource = (userId: string, since: Date) => { requests: number; tokens: number; costUsd: number };

export type QuotaService = ReturnType<typeof createQuotaService>;

/**
 * Usage quotas per user. Usage comes from the stored hourly usage records, so it
 * survives restarts and is shared by every node using the database. Like token
 * limits, usage is charged when a request finishes: requests running at the same
 * moment can together go past the quota.
 */
export function createQuotaService(options: {
  store: QuotaStore;
  usage: QuotaUsageSource;
  access: QuotaAccess;
  audit: AuditService;
  events?: EventBus;
  log?: Logger;
  now?: () => Date;
  /** How long the quota list is cached; changes made on another node show up after this (default 30 s). */
  cacheMs?: number;
}) {
  const { store, audit, events, log } = options;
  const now = options.now ?? (() => new Date());
  const cacheMs = options.cacheMs ?? 30_000;
  let cache: { at: number; quotas: Map<string, UserQuota> } | null = null;
  const quotas = () => {
    const t = now().getTime();
    if (!cache || t - cache.at > cacheMs || t < cache.at) cache = { at: t, quotas: store.all() };
    return cache.quotas;
  };

  function usageOf(userId: string, quota: UserQuota): QuotaUsage {
    const period = quotaPeriod(quota, now());
    const u = options.usage(userId, period.start);
    const used = quota.unit === 'tokens' ? u.tokens : quota.unit === 'requests' ? u.requests : Math.round(u.costUsd * 10_000) / 10_000;
    return { used, limit: quota.amount, periodStart: period.start.toISOString(), resetsAt: period.end.toISOString() };
  }

  const view = (userId: string): UserQuotaView => {
    const quota = quotas().get(userId) ?? null;
    return { userId, quota, usage: quota ? usageOf(userId, quota) : null };
  };

  return {
    /** A user's quota and where they stand. 404 for unknown users. */
    get(userId: string): UserQuotaView {
      if (options.access.username(userId) === null) throw errors.notFound('User not found.');
      return view(userId);
    },

    /** Sets (or with null, removes) a user's quota. Audited. */
    set(actor: QuotaActor, userId: string, value: unknown, client: { ip: string | null; requestId?: string | null }): UserQuotaView {
      const username = options.access.username(userId);
      if (username === null) throw errors.notFound('User not found.');
      const issues: FieldIssue[] = [];
      const quota = value === null ? null : checkQuota(value, 'quota', issues);
      if (issues.length) throw errors.validation(issues);
      if (userId !== actor.id) options.access.assertCanManage(actor, userId);
      const before = quotas().get(userId) ?? null;
      if (JSON.stringify(before) === JSON.stringify(quota)) return view(userId);
      store.set(userId, quota, now().toISOString(), actor.id);
      cache = null;
      audit.record({
        action: 'USER_QUOTA_UPDATED', result: 'SUCCESS', resource: 'user', resourceId: userId,
        actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null,
        metadata: { username, from: before, to: quota },
      });
      events?.emit('quota.changed', { userId, updatedBy: actor.id });
      log?.info('user quota updated', { component: 'quotas', userId, removed: quota === null });
      return view(userId);
    },

    /** Validates a quota without saving it (for user creation, before the user exists). */
    validate(value: unknown, path = 'quota'): FieldIssue[] {
      const issues: FieldIssue[] = [];
      if (value !== null && value !== undefined) checkQuota(value, path, issues);
      return issues;
    },

    /**
     * Throws RATE_LIMITED (429, code `quota_exceeded`, Retry-After until the reset)
     * when the key's owner has used up their quota. Users without a quota pass.
     */
    check(userId: string | null, requestId: string | null): void {
      if (!userId) return;
      const quota = quotas().get(userId);
      if (!quota) return;
      const u = usageOf(userId, quota);
      if (u.used < quota.amount) return;
      const resetsAt = new Date(u.resetsAt);
      const retry = Math.max(1, Math.ceil((resetsAt.getTime() - now().getTime()) / 1000));
      events?.emit('quota.exceeded', { userId, unit: quota.unit, limit: quota.amount, resetsAt: u.resetsAt, requestId });
      log?.info('usage quota reached', { component: 'quotas', userId, unit: quota.unit, requestId });
      throw new AppError('RATE_LIMITED',
        `Your usage quota is used up: ${quota.unit === 'cost' ? formatQuotaAmount('cost', u.used) : Math.round(u.used).toLocaleString('en-US')} of ${formatQuotaAmount(quota.unit, quota.amount)} ${PERIOD_WORDS[quota.period]}. ` +
        `It resets on ${formatReset(resetsAt, quota.timeZone)}. An administrator can raise it.`, {
          expose: true,
          headers: { 'Retry-After': String(retry) },
          details: { code: 'quota_exceeded', scope: 'quota', resetsAt: u.resetsAt },
        });
    },
  };
}
