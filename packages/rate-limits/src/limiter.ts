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

import { AppError, errors, RollingSum, type EventBus, type Logger } from '@clawrouter/core';
import type { AuditService } from '@clawrouter/audit';
import {
  NO_RATE_LIMIT, RATE_WINDOW_MS,
  type PutRateLimitsRequest, type RateLimit, type RateLimitConfig, type RateLimitConfigView, type RateLimitScope, type RateLimitUsage,
  type RateLimitUsageEntry, type RateWindow, type TokenBucket,
} from '@clawrouter/shared';
import type { RateLimitConfigStore } from './config-store.ts';
import { diffSettings, normalizeSettings, upgradeSettings, validateRateLimits } from './config.ts';
import type { BucketSpec, CounterStore } from './counters.ts';

/** The invalid-key limit per address is always per minute. */
const IP_WINDOW_MS = 60_000;

/** Who is making a gateway request. */
export interface LimitSubject {
  keyId: string;
  /** The user who created the key; their keys share the per-user limit. */
  ownerId: string | null;
  /** The key's own limit, or null for the default per-key limit. */
  keyLimit: RateLimit | null;
}

/** Names for ids in the usage view. Provided by the API-key service. */
export interface SubjectDirectory {
  describeKey(id: string): { label: string; limit: RateLimit | null } | null;
  describeUser(id: string): string | null;
}

/** A request admitted past the limits. Release it when the request ends, and charge its tokens. */
export interface Admission {
  /** `x-ratelimit-*` headers describing the tightest limit that applies. */
  headers: Record<string, string>;
  /** Charges provider-reported tokens to the key, user and global token counters. */
  charge(tokens: number): Promise<void>;
  /** Ends the request for the concurrency limit. Safe to call twice. */
  release(): Promise<void>;
}

type Kind = 'requests' | 'tokens' | 'burst' | 'concurrency' | 'invalid_keys';

/** Why a model was skipped for its own limit. */
export interface ModelDenial {
  retryAfterMs: number;
  kind: 'requests' | 'tokens' | 'burst';
  limit: number;
  window: RateWindow;
  bucket?: TokenBucket | null;
}

interface Check {
  scope: RateLimitScope;
  subject: string;
  limit: RateLimit;
}

const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));
const fmt = (n: number) => n.toLocaleString('en-US');
const W = { second: 's', minute: 'm', hour: 'h' } as const satisfies Record<RateWindow, string>;
const WINDOW_OF = { s: 'second', m: 'minute', h: 'hour' } as const;
const counterKey = (kind: 'req' | 'tok', c: { scope: RateLimitScope; subject: string; limit: RateLimit }) => `${kind}:${W[c.limit.window]}:${c.scope}:${c.subject}`;
const bucketKey = (c: { scope: RateLimitScope; subject: string }) => `bkt:${c.scope}:${c.subject}`;
const spec = (b: TokenBucket): BucketSpec => ({ capacity: b.capacity, refillAmount: b.refillAmount, refillEveryMs: b.refillEverySeconds * 1000 });

/** "1 every 2 s", "10 every second". */
export function describeRefill(b: TokenBucket): string {
  const every = b.refillEverySeconds === 1 ? 'second' : b.refillEverySeconds % 3600 === 0 ? `${b.refillEverySeconds / 3600} h` : b.refillEverySeconds % 60 === 0 ? `${b.refillEverySeconds / 60} min` : `${b.refillEverySeconds} s`;
  return `${fmt(b.refillAmount)} every ${every}`;
}

function describe(scope: RateLimitScope, kind: Kind, limit: number, window: RateWindow, bucket?: TokenBucket | null): string {
  const what = kind === 'tokens' ? `${fmt(limit)} ${limit === 1 ? 'token' : 'tokens'} per ${window}`
    : kind === 'burst' && bucket ? `bursts of up to ${fmt(bucket.capacity)} requests, then ${describeRefill(bucket)}`
      : `${fmt(limit)} ${limit === 1 ? 'request' : 'requests'} per ${window}`;
  const prefix = kind === 'burst' ? 'Too many requests in a short time' : 'Rate limit reached';
  switch (scope) {
    case 'key': return `${prefix} for this API key (${what}).`;
    case 'user': return `${prefix} for your account: all of your API keys together (${what}).`;
    case 'model': return `${prefix} for this model (${what}).`;
    case 'ip': return 'Too many requests with invalid API keys from this address.';
    default: return kind === 'concurrency' ? 'The gateway is handling too many requests at once.' : `${prefix} for the whole gateway (${what}).`;
  }
}

export type RateLimitService = ReturnType<typeof createRateLimitService>;

/**
 * Rate limiting at the gateway (spec §12): per key, per user, per model, global
 * and per IP for invalid keys. Each limit counts requests and tokens over a
 * window of a second, minute or hour, and may add a token bucket against bursts.
 * Configuration is stored in the database; counters live in a `CounterStore`
 * (in memory today, replaceable by a shared store).
 */
export function createRateLimitService(options: {
  store: RateLimitConfigStore;
  counters: CounterStore;
  audit: AuditService;
  /** Registered model references, to report limits on models that no longer exist. */
  knownModels: () => string[];
  directory?: SubjectDirectory;
  events?: EventBus;
  log?: Logger;
  now?: () => Date;
}) {
  const { store, counters, audit, events, log } = options;
  const now = options.now ?? (() => new Date());
  let cached: RateLimitConfig | null = null;
  const config = () => (cached ??= store.load());
  let rejectedTotal = 0;
  // Refusals in the last minute, in one-second buckets: constant cost even under a flood of 429s.
  const rejectedRecently = new RollingSum(1_000, 60);

  function rejected(
    check: { scope: RateLimitScope; subject: string }, kind: Kind, limit: number, retryAfterMs: number, requestId: string | null,
    headers: Record<string, string> = {}, window: RateWindow = 'minute', bucket?: TokenBucket | null,
  ): AppError {
    const at = now().getTime();
    rejectedTotal += 1;
    rejectedRecently.add(at);
    const retry = seconds(retryAfterMs);
    events?.emit('ratelimit.exceeded', { scope: check.scope, subject: check.subject, kind, limit, retryAfterSeconds: retry, requestId });
    log?.info('rate limit reached', { component: 'rate-limits', scope: check.scope, kind, limit, window, requestId });
    return new AppError('RATE_LIMITED', `${describe(check.scope, kind, limit, window, bucket)} Try again in ${retry} s.`, {
      expose: true,
      headers: { ...headers, 'Retry-After': String(retry) },
      details: { scope: check.scope, kind },
    });
  }

  const modelLimit = (ref: string) => config().perModel.find((m) => m.model.toLowerCase() === ref.toLowerCase()) ?? null;
  const ipKey = (ip: string | null) => `fail:ip:${ip ?? 'unknown'}`;

  /** Headers for the tightest of the limits (lowest remaining). */
  async function headersFor(checks: Check[]): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    for (const kind of ['requests', 'tokens'] as const) {
      let best: { limit: number; remaining: number; resetMs: number } | null = null;
      for (const c of checks) {
        const limit = kind === 'requests' ? c.limit.requests : c.limit.tokens;
        if (limit === null) continue;
        const s = await counters.peek(counterKey(kind === 'requests' ? 'req' : 'tok', c), RATE_WINDOW_MS[c.limit.window]);
        const remaining = Math.max(0, Math.floor(limit - s.used));
        if (!best || remaining < best.remaining) best = { limit, remaining, resetMs: s.resetMs };
      }
      if (best) {
        headers[`x-ratelimit-limit-${kind}`] = String(best.limit);
        headers[`x-ratelimit-remaining-${kind}`] = String(best.remaining);
        headers[`x-ratelimit-reset-${kind}`] = `${seconds(best.resetMs)}s`;
      }
    }
    return headers;
  }

  return {
    get(): RateLimitConfigView {
      const c = config();
      const known = new Set(options.knownModels().map((r) => r.toLowerCase()));
      return { ...c, unknownModels: c.perModel.map((m) => m.model).filter((m) => !known.has(m.toLowerCase())) };
    },

    update(actor: { id: string; username: string }, raw: PutRateLimitsRequest, client: { ip: string | null; requestId?: string | null }): RateLimitConfigView {
      // Old `{ requestsPerMinute, tokensPerMinute }` limits (older clients, exported files) are accepted.
      const body = upgradeSettings(raw) as PutRateLimitsRequest;
      const issues = validateRateLimits(body);
      if (issues.length) throw errors.validation(issues);
      const current = store.load();
      const conflict = () => new AppError('CONFLICT', 'The rate limits were changed by someone else. Reload them and apply your change again.', { details: { currentVersion: current.version } });
      if (body.version !== current.version) throw conflict();
      const settings = normalizeSettings(body);
      const saved = store.save(settings, body.version, now().toISOString(), actor.id);
      if (!saved) throw conflict();
      cached = saved;
      audit.record({
        action: 'RATE_LIMITS_UPDATED', result: 'SUCCESS', resource: 'rate_limits', resourceId: String(saved.version),
        actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null,
        metadata: { version: saved.version, ...diffSettings(current, settings) },
      });
      events?.emit('ratelimits.changed', { version: saved.version, updatedBy: actor.id });
      log?.info('rate limits updated', { component: 'rate-limits', version: saved.version });
      return this.get();
    },

    /**
     * Admits a gateway request or throws RATE_LIMITED (429 with Retry-After).
     * Checks concurrency, then tokens (budget left), requests and burst buckets;
     * a request is counted only when every limit lets it through.
     */
    async admit(subject: LimitSubject, requestId: string | null): Promise<Admission> {
      const c = config();
      const checks: Check[] = [{ scope: 'key', subject: subject.keyId, limit: subject.keyLimit ?? c.perKey }];
      if (subject.ownerId) checks.push({ scope: 'user', subject: subject.ownerId, limit: c.perUser });
      checks.push({ scope: 'global', subject: 'global', limit: c.global });

      if (!(await counters.acquire('conc:global', c.global.maxConcurrent))) {
        throw rejected({ scope: 'global', subject: 'global' }, 'concurrency', c.global.maxConcurrent ?? 0, 1000, requestId);
      }
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        await counters.release('conc:global');
      };
      try {
        for (const check of checks) {
          const { tokens, window } = check.limit;
          if (tokens === null) continue;
          const s = await counters.peek(counterKey('tok', check), RATE_WINDOW_MS[window], 1, tokens);
          if (s.retryAfterMs > 0) throw rejected(check, 'tokens', tokens, s.retryAfterMs, requestId, await headersFor(checks), window);
        }
        for (const check of checks) {
          const { requests, window } = check.limit;
          if (requests === null) continue;
          const s = await counters.peek(counterKey('req', check), RATE_WINDOW_MS[window], 1, requests);
          if (s.retryAfterMs > 0) throw rejected(check, 'requests', requests, s.retryAfterMs, requestId, await headersFor(checks), window);
        }
        for (const check of checks) {
          const { bucket, window } = check.limit;
          if (!bucket) continue;
          const s = await counters.takeBucket(bucketKey(check), spec(bucket), 1, true);
          if (!s.allowed) throw rejected(check, 'burst', bucket.capacity, s.retryAfterMs, requestId, await headersFor(checks), window, bucket);
        }
        // Every limit allows it: count it everywhere.
        for (const check of checks) {
          await counters.consume(counterKey('req', check), 1, null, RATE_WINDOW_MS[check.limit.window]);
          if (check.limit.bucket) await counters.takeBucket(bucketKey(check), spec(check.limit.bucket), 1);
        }
      } catch (error) {
        await release();
        throw error;
      }
      const headers = await headersFor(checks);
      return {
        headers,
        release,
        async charge(tokens: number) {
          if (!(tokens > 0)) return;
          for (const check of checks) await counters.add(counterKey('tok', check), tokens, RATE_WINDOW_MS[check.limit.window]);
        },
      };
    },

    /**
     * Counts an attempt on a model with a limit. Returns null when allowed, or the
     * time until it would be. A limited model is skipped like an unavailable one.
     */
    async useModel(modelRef: string): Promise<ModelDenial | null> {
      const m = modelLimit(modelRef);
      if (!m) return null;
      const check = { scope: 'model' as const, subject: m.model.toLowerCase(), limit: m };
      const ms = RATE_WINDOW_MS[m.window];
      if (m.tokens !== null) {
        const s = await counters.peek(counterKey('tok', check), ms, 1, m.tokens);
        if (s.retryAfterMs > 0) return { retryAfterMs: s.retryAfterMs, kind: 'tokens', limit: m.tokens, window: m.window };
      }
      if (m.requests !== null) {
        const s = await counters.peek(counterKey('req', check), ms, 1, m.requests);
        if (s.retryAfterMs > 0) return { retryAfterMs: s.retryAfterMs, kind: 'requests', limit: m.requests, window: m.window };
      }
      if (m.bucket) {
        const s = await counters.takeBucket(bucketKey(check), spec(m.bucket), 1);
        if (!s.allowed) return { retryAfterMs: s.retryAfterMs, kind: 'burst', limit: m.bucket.capacity, window: m.window, bucket: m.bucket };
      }
      await counters.consume(counterKey('req', check), 1, null, ms);
      return null;
    },

    async chargeModel(modelRef: string, tokens: number) {
      const m = modelLimit(modelRef);
      if (m && tokens > 0) await counters.add(counterKey('tok', { scope: 'model', subject: m.model.toLowerCase(), limit: m }), tokens, RATE_WINDOW_MS[m.window]);
    },

    /** Builds the 429 for a request whose every candidate model was rate limited. */
    modelsExhausted(modelRef: string, denial: ModelDenial, requestId: string | null): AppError {
      return rejected({ scope: 'model', subject: modelRef }, denial.kind, denial.limit, denial.retryAfterMs, requestId, {}, denial.window, denial.bucket);
    },

    /** Milliseconds this IP must wait because of too many invalid keys; 0 when allowed. */
    async ipBlockedFor(ip: string | null): Promise<number> {
      const s = await counters.peek(ipKey(ip), IP_WINDOW_MS, 1, config().invalidKeysPerIp);
      return s.retryAfterMs;
    },

    /** Records a failed API-key authentication from `ip`. */
    async invalidKey(ip: string | null) {
      await counters.add(ipKey(ip), 1, IP_WINDOW_MS);
    },

    /** 429 for a blocked IP (also counted and emitted as an event). */
    ipBlocked(ip: string | null, retryAfterMs: number, requestId: string | null): AppError {
      return rejected({ scope: 'ip', subject: ip ?? 'unknown' }, 'invalid_keys', config().invalidKeysPerIp, retryAfterMs, requestId);
    },

    rejections(): { lastMinute: number; total: number } {
      return { lastMinute: rejectedRecently.sum(now().getTime()), total: rejectedTotal };
    },

    /** Live counters with a non-zero value, for the console. */
    async usage(): Promise<RateLimitUsage> {
      const c = config();
      const entries = new Map<string, RateLimitUsageEntry>();
      const limitOf = (scope: RateLimitScope, subject: string): { label: string; limit: RateLimit } => {
        if (scope === 'key') {
          const d = options.directory?.describeKey(subject);
          return { label: d?.label ?? '(deleted key)', limit: d?.limit ?? c.perKey };
        }
        if (scope === 'user') return { label: options.directory?.describeUser(subject) ?? '(deleted user)', limit: c.perUser };
        if (scope === 'model') {
          const m = modelLimit(subject);
          return { label: m?.model ?? subject, limit: m ? { window: m.window, requests: m.requests, tokens: m.tokens, bucket: m.bucket } : NO_RATE_LIMIT };
        }
        if (scope === 'global') return { label: 'All requests', limit: { window: c.global.window, requests: c.global.requests, tokens: c.global.tokens, bucket: c.global.bucket } };
        return { label: subject, limit: { window: 'minute', requests: c.invalidKeysPerIp, tokens: null, bucket: null } };
      };
      const entry = (scope: RateLimitScope, subject: string): RateLimitUsageEntry => {
        const id = `${scope}:${subject}`;
        let e = entries.get(id);
        if (!e) {
          e = { scope, subject, requests: 0, tokens: 0, ...limitOf(scope, subject) };
          entries.set(id, e);
        }
        return e;
      };
      for (const prefix of ['req:', 'tok:'] as const) {
        for (const key of await counters.keys(prefix)) {
          const [, w, scope, ...rest] = key.split(':');
          const window = WINDOW_OF[w as keyof typeof WINDOW_OF];
          const e = entry(scope as RateLimitScope, rest.join(':'));
          // A counter left from before the window was changed no longer applies.
          if (!window || window !== e.limit.window) continue;
          const s = await counters.peek(key, RATE_WINDOW_MS[window]);
          if (prefix === 'req:') e.requests = Math.round(s.used);
          else e.tokens = Math.round(s.used);
        }
      }
      for (const key of await counters.keys('fail:ip:')) {
        const ip = key.slice('fail:ip:'.length);
        const s = await counters.peek(key, IP_WINDOW_MS, 1, c.invalidKeysPerIp);
        const e = entry('ip', ip);
        e.requests = Math.round(s.used);
        e.blocked = s.retryAfterMs > 0;
      }
      const g = entry('global', 'global');
      g.concurrent = await counters.inFlight('conc:global');
      for (const e of entries.values()) {
        if (e.limit.bucket && e.scope !== 'ip') e.bucketAvailable = (await counters.takeBucket(bucketKey(e), spec(e.limit.bucket), 1, true)).available;
      }
      const order: RateLimitScope[] = ['global', 'key', 'user', 'model', 'ip'];
      const list = [...entries.values()]
        .filter((e) => e.scope === 'global' || e.requests > 0 || e.tokens > 0 || (e.bucketAvailable !== undefined && e.bucketAvailable < e.limit.bucket!.capacity))
        .sort((a, b) => order.indexOf(a.scope) - order.indexOf(b.scope) || b.requests - a.requests);
      const r = this.rejections();
      return { entries: list, rejectedLastMinute: r.lastMinute, rejectedTotal: r.total };
    },
  };
}
