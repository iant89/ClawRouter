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

import {
  BUCKET_CAPACITY_MAX, BUCKET_REFILL_SECONDS_MAX, DEFAULT_RATE_LIMITS, RATE_LIMIT_MAX, RATE_WINDOWS,
  type FieldIssue, type RateLimit, type RateLimitConfig, type RateLimitSettings, type RateWindow, type TokenBucket,
} from '@clawrouter/shared';

export const MAX_MODEL_LIMITS = 500;

export function defaultConfig(): RateLimitConfig {
  return { ...structuredClone(DEFAULT_RATE_LIMITS), version: 0, updatedAt: null, updatedBy: null };
}

const fmt = (n: number) => n.toLocaleString('en-US');

function checkWhole(value: unknown, path: string, issues: FieldIssue[], min: number, max: number, nullable: boolean) {
  if (value === null && nullable) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    issues.push({ path, message: `must be a whole number from ${fmt(min)} to ${fmt(max)}${nullable ? ', or null for no limit' : ''}` });
  }
}

/**
 * Limits stored or sent before windows existed were `{ requestsPerMinute,
 * tokensPerMinute }`. They become a one-minute window without a bucket; anything
 * else is returned as it is (and validated as the current shape).
 */
export function upgradeLimit(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const l = value as Record<string, unknown>;
  if (!('requestsPerMinute' in l || 'tokensPerMinute' in l) || 'window' in l) return value;
  const { requestsPerMinute, tokensPerMinute, ...rest } = l;
  return { ...rest, window: 'minute', requests: requestsPerMinute ?? null, tokens: tokensPerMinute ?? null, bucket: null };
}

/** `upgradeLimit` for every limit in a settings document (stored, imported or sent). */
export function upgradeSettings(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const s = { ...(value as Record<string, unknown>) };
  for (const k of ['perKey', 'perUser', 'global'] as const) if (k in s) s[k] = upgradeLimit(s[k]);
  if (Array.isArray(s.perModel)) s.perModel = s.perModel.map(upgradeLimit);
  return s;
}

function checkBucket(value: unknown, path: string, issues: FieldIssue[]) {
  if (value === null || value === undefined) return;
  if (typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ path, message: 'must be { capacity, refillAmount, refillEverySeconds }, or null for no bucket' });
    return;
  }
  const b = value as Record<string, unknown>;
  checkWhole(b.capacity, `${path}.capacity`, issues, 1, BUCKET_CAPACITY_MAX, false);
  checkWhole(b.refillAmount, `${path}.refillAmount`, issues, 1, BUCKET_CAPACITY_MAX, false);
  checkWhole(b.refillEverySeconds, `${path}.refillEverySeconds`, issues, 1, BUCKET_REFILL_SECONDS_MAX, false);
  if (typeof b.capacity === 'number' && typeof b.refillAmount === 'number' && b.refillAmount > b.capacity) {
    issues.push({ path: `${path}.refillAmount`, message: 'cannot be more than the capacity' });
  }
}

/** Validates one limit: `{ window, requests, tokens, bucket }`. */
export function checkRateLimit(limit: unknown, path: string, issues: FieldIssue[]): limit is RateLimit {
  if (typeof limit !== 'object' || limit === null || Array.isArray(limit)) {
    issues.push({ path, message: 'must be an object with window, requests, tokens and bucket' });
    return false;
  }
  const l = limit as Record<string, unknown>;
  if (l.window !== undefined && !RATE_WINDOWS.includes(l.window as RateWindow)) {
    issues.push({ path: `${path}.window`, message: 'must be second, minute or hour' });
  }
  checkWhole(l.requests ?? null, `${path}.requests`, issues, 1, RATE_LIMIT_MAX, true);
  checkWhole(l.tokens ?? null, `${path}.tokens`, issues, 1, RATE_LIMIT_MAX, true);
  checkBucket(l.bucket, `${path}.bucket`, issues);
  return true;
}

const normalizeBucket = (b: Partial<TokenBucket> | null | undefined): TokenBucket | null =>
  b ? { capacity: b.capacity!, refillAmount: b.refillAmount!, refillEverySeconds: b.refillEverySeconds! } : null;

/** Normalizes a limit (missing fields become their defaults; old shapes are upgraded). */
export const normalizeLimit = (raw: Partial<RateLimit> | null | undefined): RateLimit => {
  const l = upgradeLimit(raw) as Partial<RateLimit> | null | undefined;
  return { window: l?.window ?? 'minute', requests: l?.requests ?? null, tokens: l?.tokens ?? null, bucket: normalizeBucket(l?.bucket) };
};

export const limitIsEmpty = (l: RateLimit) => l.requests === null && l.tokens === null && l.bucket === null;

/** Validates the settings document. Model references are checked separately (unknown ones are allowed but reported). */
export function validateRateLimits(s: RateLimitSettings): FieldIssue[] {
  const issues: FieldIssue[] = [];
  checkRateLimit(s.perKey, 'perKey', issues);
  checkRateLimit(s.perUser, 'perUser', issues);
  if (checkRateLimit(s.global, 'global', issues)) checkWhole(s.global.maxConcurrent ?? null, 'global.maxConcurrent', issues, 1, RATE_LIMIT_MAX, true);
  if (!Number.isInteger(s.invalidKeysPerIp) || s.invalidKeysPerIp < 1 || s.invalidKeysPerIp > 10_000) {
    issues.push({ path: 'invalidKeysPerIp', message: 'must be a whole number from 1 to 10,000' });
  }
  if (!Array.isArray(s.perModel)) {
    issues.push({ path: 'perModel', message: 'must be a list' });
    return issues;
  }
  if (s.perModel.length > MAX_MODEL_LIMITS) issues.push({ path: 'perModel', message: `at most ${MAX_MODEL_LIMITS} model limits` });
  const seen = new Set<string>();
  s.perModel.forEach((m, i) => {
    const p = `perModel[${i}]`;
    if (typeof m?.model !== 'string' || !/^[^/\s]+\/\S+$/.test(m.model) || m.model.length > 300) {
      issues.push({ path: `${p}.model`, message: 'must be a model reference, provider/model' });
    } else if (seen.has(m.model.toLowerCase())) {
      issues.push({ path: `${p}.model`, message: `"${m.model}" has two limits` });
    } else seen.add(m.model.toLowerCase());
    if (checkRateLimit(m, p, issues) && m.requests == null && m.tokens == null && m.bucket == null) {
      issues.push({ path: p, message: 'set requests, tokens or a burst bucket, or remove the model' });
    }
  });
  return issues;
}

export function normalizeSettings(s: RateLimitSettings): RateLimitSettings {
  return {
    perKey: normalizeLimit(s.perKey),
    perUser: normalizeLimit(s.perUser),
    perModel: s.perModel.map((m) => ({ model: m.model.trim(), ...normalizeLimit(m) })),
    global: { ...normalizeLimit(s.global), maxConcurrent: s.global.maxConcurrent ?? null },
    invalidKeysPerIp: s.invalidKeysPerIp,
  };
}

/** What changed, for the audit record (values only; nothing secret lives here). */
export function diffSettings(before: RateLimitSettings, after: RateLimitSettings): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const k of ['perKey', 'perUser', 'global', 'invalidKeysPerIp'] as const) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed[k] = { from: before[k], to: after[k] };
  }
  const b = new Map(before.perModel.map((m) => [m.model, m]));
  const a = new Map(after.perModel.map((m) => [m.model, m]));
  const added = [...a.keys()].filter((k) => !b.has(k));
  const removed = [...b.keys()].filter((k) => !a.has(k));
  const modified = [...a.keys()].filter((k) => b.has(k) && JSON.stringify(a.get(k)) !== JSON.stringify(b.get(k)));
  if (added.length || removed.length || modified.length) changed.perModel = { added, removed, changed: modified };
  return changed;
}
