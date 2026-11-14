import { AppError, errors, RollingSum, type EventBus, type Logger } from '@clawrouter/core';
import type { AuditService } from '@clawrouter/audit';
import type {
  PutRateLimitsRequest, RateLimit, RateLimitConfig, RateLimitConfigView, RateLimitScope, RateLimitUsage, RateLimitUsageEntry,
} from '@clawrouter/shared';
import type { RateLimitConfigStore } from './config-store.ts';
import { diffSettings, normalizeSettings, validateRateLimits } from './config.ts';
import type { CounterStore } from './counters.ts';

const WINDOW_MS = 60_000;

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

type Kind = 'requests' | 'tokens' | 'concurrency' | 'invalid_keys';

interface Check {
  scope: RateLimitScope;
  subject: string;
  limit: RateLimit;
}

const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));
const NO_LIMIT: RateLimit = { requestsPerMinute: null, tokensPerMinute: null };

function describe(scope: RateLimitScope, kind: Kind, limit: number): string {
  const what = kind === 'tokens' ? `${limit.toLocaleString('en-US')} tokens per minute` : `${limit.toLocaleString('en-US')} requests per minute`;
  switch (scope) {
    case 'key': return `Rate limit reached for this API key (${what}).`;
    case 'user': return `Rate limit reached for the API keys of this key's owner (${what}).`;
    case 'model': return `Rate limit reached for this model (${what}).`;
    case 'ip': return 'Too many requests with invalid API keys from this address.';
    default: return kind === 'concurrency' ? 'The gateway is handling too many requests at once.' : `The gateway's overall rate limit was reached (${what}).`;
  }
}

export type RateLimitService = ReturnType<typeof createRateLimitService>;

/**
 * Rate limiting at the gateway (spec §12): per key, per user, per model, global
 * and per IP for invalid keys. Configuration is stored in the database; counters
 * live in a `CounterStore` (in memory today, replaceable by a shared store).
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

  function rejected(check: { scope: RateLimitScope; subject: string }, kind: Kind, limit: number, retryAfterMs: number, requestId: string | null, headers: Record<string, string> = {}): AppError {
    const at = now().getTime();
    rejectedTotal += 1;
    rejectedRecently.add(at);
    const retry = seconds(retryAfterMs);
    events?.emit('ratelimit.exceeded', { scope: check.scope, subject: check.subject, kind, limit, retryAfterSeconds: retry, requestId });
    log?.info('rate limit reached', { component: 'rate-limits', scope: check.scope, kind, limit, requestId });
    return new AppError('RATE_LIMITED', `${describe(check.scope, kind, limit)} Try again in ${retry} s.`, {
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
        const limit = kind === 'requests' ? c.limit.requestsPerMinute : c.limit.tokensPerMinute;
        if (limit === null) continue;
        const s = await counters.peek(`${kind === 'requests' ? 'req' : 'tok'}:${c.scope}:${c.subject}`, WINDOW_MS);
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

    update(actor: { id: string; username: string }, body: PutRateLimitsRequest, client: { ip: string | null; requestId?: string | null }): RateLimitConfigView {
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
     * Checks concurrency, then tokens (budget left), then requests; a request is
     * counted only when every limit lets it through.
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
          const tpm = check.limit.tokensPerMinute;
          if (tpm === null) continue;
          const s = await counters.peek(`tok:${check.scope}:${check.subject}`, WINDOW_MS, 1, tpm);
          if (s.retryAfterMs > 0) throw rejected(check, 'tokens', tpm, s.retryAfterMs, requestId, await headersFor(checks));
        }
        for (const check of checks) {
          const rpm = check.limit.requestsPerMinute;
          if (rpm === null) continue;
          const s = await counters.peek(`req:${check.scope}:${check.subject}`, WINDOW_MS, 1, rpm);
          if (s.retryAfterMs > 0) throw rejected(check, 'requests', rpm, s.retryAfterMs, requestId, await headersFor(checks));
        }
        for (const check of checks) await counters.consume(`req:${check.scope}:${check.subject}`, 1, null, WINDOW_MS);
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
          for (const check of checks) await counters.add(`tok:${check.scope}:${check.subject}`, tokens, WINDOW_MS);
        },
      };
    },

    /**
     * Counts an attempt on a model with a limit. Returns null when allowed, or the
     * time until it would be. A limited model is skipped like an unavailable one.
     */
    async useModel(modelRef: string): Promise<{ retryAfterMs: number; kind: 'requests' | 'tokens'; limit: number } | null> {
      const m = modelLimit(modelRef);
      if (!m) return null;
      const key = m.model.toLowerCase();
      if (m.tokensPerMinute !== null) {
        const s = await counters.peek(`tok:model:${key}`, WINDOW_MS, 1, m.tokensPerMinute);
        if (s.retryAfterMs > 0) return { retryAfterMs: s.retryAfterMs, kind: 'tokens', limit: m.tokensPerMinute };
      }
      const r = await counters.consume(`req:model:${key}`, 1, m.requestsPerMinute, WINDOW_MS);
      if (!r.allowed) return { retryAfterMs: r.retryAfterMs, kind: 'requests', limit: m.requestsPerMinute! };
      return null;
    },

    async chargeModel(modelRef: string, tokens: number) {
      const m = modelLimit(modelRef);
      if (m && tokens > 0) await counters.add(`tok:model:${m.model.toLowerCase()}`, tokens, WINDOW_MS);
    },

    /** Builds the 429 for a request whose every candidate model was rate limited. */
    modelsExhausted(modelRef: string, retryAfterMs: number, kind: 'requests' | 'tokens', limit: number, requestId: string | null): AppError {
      return rejected({ scope: 'model', subject: modelRef }, kind, limit, retryAfterMs, requestId);
    },

    /** Milliseconds this IP must wait because of too many invalid keys; 0 when allowed. */
    async ipBlockedFor(ip: string | null): Promise<number> {
      const s = await counters.peek(ipKey(ip), WINDOW_MS, 1, config().invalidKeysPerIp);
      return s.retryAfterMs;
    },

    /** Records a failed API-key authentication from `ip`. */
    async invalidKey(ip: string | null) {
      await counters.add(ipKey(ip), 1, WINDOW_MS);
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
      const entry = (scope: RateLimitScope, subject: string): RateLimitUsageEntry => {
        const id = `${scope}:${subject}`;
        let e = entries.get(id);
        if (!e) {
          let label = subject;
          let limit: RateLimit = NO_LIMIT;
          if (scope === 'key') {
            const d = options.directory?.describeKey(subject);
            label = d?.label ?? '(deleted key)';
            limit = d?.limit ?? c.perKey;
          } else if (scope === 'user') {
            label = options.directory?.describeUser(subject) ?? '(deleted user)';
            limit = c.perUser;
          } else if (scope === 'model') {
            const m = modelLimit(subject);
            label = m?.model ?? subject;
            limit = m ? { requestsPerMinute: m.requestsPerMinute, tokensPerMinute: m.tokensPerMinute } : NO_LIMIT;
          } else if (scope === 'global') {
            label = 'All requests';
            limit = { requestsPerMinute: c.global.requestsPerMinute, tokensPerMinute: c.global.tokensPerMinute };
          } else {
            limit = { requestsPerMinute: c.invalidKeysPerIp, tokensPerMinute: null };
          }
          e = { scope, subject, label, requestsLastMinute: 0, tokensLastMinute: 0, limit };
          entries.set(id, e);
        }
        return e;
      };
      for (const prefix of ['req:', 'tok:'] as const) {
        for (const key of await counters.keys(prefix)) {
          const [, scope, ...rest] = key.split(':');
          const s = await counters.peek(key, WINDOW_MS);
          const e = entry(scope as RateLimitScope, rest.join(':'));
          if (prefix === 'req:') e.requestsLastMinute = Math.round(s.used);
          else e.tokensLastMinute = Math.round(s.used);
        }
      }
      for (const key of await counters.keys('fail:ip:')) {
        const ip = key.slice('fail:ip:'.length);
        const s = await counters.peek(key, WINDOW_MS, 1, c.invalidKeysPerIp);
        const e = entry('ip', ip);
        e.requestsLastMinute = Math.round(s.used);
        e.blocked = s.retryAfterMs > 0;
      }
      const g = entry('global', 'global');
      g.concurrent = await counters.inFlight('conc:global');
      const order: RateLimitScope[] = ['global', 'key', 'user', 'model', 'ip'];
      const list = [...entries.values()].sort((a, b) => order.indexOf(a.scope) - order.indexOf(b.scope) || b.requestsLastMinute - a.requestsLastMinute);
      const r = this.rejections();
      return { entries: list, rejectedLastMinute: r.lastMinute, rejectedTotal: r.total };
    },
  };
}
