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

import { COST_PERIODS, type CostLimit, type CostLimits, type CostPeriod } from '@clawrouter/shared';

/** Whose spending a cost limit counts. */
export type SpendScope = 'key' | 'user' | 'model' | 'provider' | 'global';

/**
 * US dollars recorded since `fromHour` (an ISO hour, inclusive) for one subject:
 * a key id, user id, model reference, provider id, or "global". Read from the
 * stored hourly usage records, so it survives restarts and is shared by nodes.
 */
export type SpendSource = (scope: SpendScope, subject: string, fromHour: string) => number;

/** The UTC calendar period containing `t`: its first hour and when it ends. */
export function costPeriod(period: CostPeriod, t: number): { start: Date; end: Date } {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (period === 'hour') {
    const start = Date.UTC(y, m, d.getUTCDate(), d.getUTCHours());
    return { start: new Date(start), end: new Date(start + 3_600_000) };
  }
  if (period === 'day') return { start: new Date(Date.UTC(y, m, d.getUTCDate())), end: new Date(Date.UTC(y, m, d.getUTCDate() + 1)) };
  return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
}

/** A limit that is reached: what, how much, and when it resets. */
export interface CostDenial {
  scope: SpendScope;
  /** The configured name: key id, user id, model reference or provider identifier. */
  subject: string;
  period: CostPeriod;
  limit: number;
  spent: number;
  retryAfterMs: number;
}

/** Who and what a request spends on. */
export interface SpendTarget {
  keyId: string;
  ownerId: string | null;
  modelRef: string;
  providerId: string;
}

/** "$5.00", "$0.0125". */
export const formatUsd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 })}`;

const PERIOD_WORDS: Record<CostPeriod, string> = { hour: 'this hour', day: 'today', month: 'this month' };
const SCOPE_WORDS: Record<SpendScope, string> = {
  key: 'this API key', user: 'your account (all of your API keys together)', model: 'this model', provider: 'this provider', global: 'the whole gateway',
};

/** The client-facing sentence for a reached cost limit (UTC periods). */
export function describeCostDenial(d: CostDenial): string {
  return `Spending limit reached for ${SCOPE_WORDS[d.scope]}: ${formatUsd(d.spent)} of ${formatUsd(d.limit)} ${PERIOD_WORDS[d.period]} (UTC).`;
}

export type CostLimiter = ReturnType<typeof createCostLimiter>;

/**
 * Spending limits per key, user, model, provider and for the whole gateway, per
 * UTC hour, day and month (SEC-005). Spend comes from the stored usage records
 * and is cached briefly; what this process charges is added to the cache at
 * once, so a burst of requests on one node sees its own spending immediately.
 * Like quotas, a request is charged when it ends: requests running at the same
 * moment can together go past a limit (bounded by `maxEstimatedCostPerRequest`).
 */
export function createCostLimiter(options: {
  limits: () => CostLimits;
  spend: SpendSource;
  now: () => Date;
  /** How long a spend total read from the database is trusted (default 5 s): other nodes' spending shows up after this. */
  cacheMs?: number;
}) {
  const cacheMs = options.cacheMs ?? 5_000;
  const cache = new Map<string, { at: number; start: number; usd: number }>();

  function spent(scope: SpendScope, subject: string, period: CostPeriod, t: number): number {
    const { start } = costPeriod(period, t);
    const id = `${scope}:${subject}:${period}`;
    const hit = cache.get(id);
    if (hit && hit.start === start.getTime() && t - hit.at < cacheMs && t >= hit.at) return hit.usd;
    const usd = options.spend(scope, subject, start.toISOString());
    cache.set(id, { at: t, start: start.getTime(), usd });
    // Bounded: entries for subjects that no longer have limits go when the map grows.
    if (cache.size > 50_000) for (const [k, v] of cache) if (t - v.at > cacheMs) cache.delete(k);
    return usd;
  }

  /** The first reached period of `limit` for this subject, or null. */
  function check(scope: SpendScope, subject: string, configured: string, limit: CostLimit): CostDenial | null {
    const t = options.now().getTime();
    for (const period of COST_PERIODS) {
      const max = limit[period];
      if (max === null) continue;
      const usd = spent(scope, subject, period, t);
      if (usd >= max) return { scope, subject: configured, period, limit: max, spent: usd, retryAfterMs: costPeriod(period, t).end.getTime() - t };
    }
    return null;
  }

  const find = <T extends { [k in F]: string }, F extends string>(list: T[], field: F, name: string) => list.find((x) => x[field].toLowerCase() === name.toLowerCase());
  const identifierOf = (modelRef: string) => modelRef.slice(0, Math.max(0, modelRef.indexOf('/')));

  return {
    /** Key, user and gateway limits: checked when a request is admitted. */
    checkSubject(keyId: string, ownerId: string | null): CostDenial | null {
      const c = options.limits();
      return check('key', keyId, keyId, c.perKey)
        ?? (ownerId ? check('user', ownerId, ownerId, c.perUser) : null)
        ?? check('global', 'global', 'global', c.global);
    },

    /** Model and provider limits: checked before each model is tried (a model over its budget is skipped). */
    checkModel(modelRef: string, providerId: string): CostDenial | null {
      const c = options.limits();
      const m = find(c.perModel, 'model', modelRef);
      const p = find(c.perProvider, 'provider', identifierOf(modelRef));
      return (m ? check('model', modelRef, m.model, m) : null) ?? (p ? check('provider', providerId, p.provider, p) : null);
    },

    /** Adds what a finished request cost to the cached totals (the usage records hold it for everyone else). */
    charge(target: SpendTarget, usd: number) {
      if (!(usd > 0)) return;
      const subjects: [SpendScope, string | null][] = [
        ['key', target.keyId], ['user', target.ownerId], ['model', target.modelRef], ['provider', target.providerId], ['global', 'global'],
      ];
      const t = options.now().getTime();
      for (const [scope, subject] of subjects) {
        if (!subject) continue;
        for (const period of COST_PERIODS) {
          const hit = cache.get(`${scope}:${subject}:${period}`);
          if (hit && hit.start === costPeriod(period, t).start.getTime()) hit.usd += usd;
        }
      }
    },

    /** Forgets cached totals (tests, and after the limits change). */
    reset() {
      cache.clear();
    },
  };
}
