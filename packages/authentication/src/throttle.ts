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

export interface ThrottleOptions {
  /** Failures allowed within `windowMs` before the key is blocked. */
  limit: number;
  windowMs: number;
  /** How long a key stays blocked once over the limit. */
  blockMs: number;
  /** Upper bound on tracked keys, so an attacker cannot exhaust memory. */
  maxKeys?: number;
  now?: () => number;
}

interface Entry {
  failures: number[];
  blockedUntil: number;
}

/**
 * In-memory failure counter for login throttling. Single-node only; phase 9
 * introduces the rate-limit abstraction that can be backed by Redis.
 */
export class FailureThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(private readonly options: ThrottleOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Milliseconds until `key` may try again; 0 when allowed. */
  retryAfter(key: string): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    return Math.max(0, entry.blockedUntil - this.now());
  }

  /** Records a failure. Returns true when this failure started a block. */
  fail(key: string): boolean {
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry) {
      this.evictIfFull();
      entry = { failures: [], blockedUntil: 0 };
      this.entries.set(key, entry);
    }
    entry.failures = entry.failures.filter((t) => now - t < this.options.windowMs);
    entry.failures.push(now);
    if (entry.failures.length >= this.options.limit) {
      entry.blockedUntil = now + this.options.blockMs;
      entry.failures = [];
      return true;
    }
    return false;
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  private evictIfFull() {
    const max = this.options.maxKeys ?? 10_000;
    if (this.entries.size < max) return;
    const now = this.now();
    for (const [key, entry] of this.entries) {
      const stale = entry.blockedUntil <= now && entry.failures.every((t) => now - t >= this.options.windowMs);
      if (stale) this.entries.delete(key);
    }
    // Still full: drop the oldest entries (Map preserves insertion order).
    for (const key of this.entries.keys()) {
      if (this.entries.size < max) break;
      this.entries.delete(key);
    }
  }
}
