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

import type { LogEntry, LogPage, LogQuery } from '@clawrouter/shared';
import type { LogLevel, LogRecord } from './logger.ts';

export type { LogEntry, LogPage, LogQuery };

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const MAX_FIELDS_BYTES = 16 * 1024;

/**
 * The most recent log records, in memory (spec §27 log filtering). A ring: the
 * oldest records drop out once `capacity` is reached, and everything is lost on
 * restart. Long-term logs belong to whatever collects the server's output.
 */
export class LogBuffer {
  private readonly ring: (LogEntry | undefined)[];
  private next = 0;
  private seq = 0;
  private readonly componentSet = new Set<string>();

  constructor(readonly capacity = 5000) {
    this.ring = new Array(capacity);
  }

  /** Use as the logger's `tap`. */
  readonly push = (record: LogRecord): void => {
    const { time, level, msg, component, requestId, providerId, userId, ...rest } = record;
    let fields: Record<string, unknown> = rest;
    if (JSON.stringify(rest).length > MAX_FIELDS_BYTES) fields = { note: `Fields larger than ${MAX_FIELDS_BYTES / 1024} KB were not kept.` };
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    this.seq += 1;
    this.ring[this.next] = {
      seq: this.seq, time, level, msg, component: str(component), requestId: str(requestId), providerId: str(providerId), userId: str(userId), fields,
    };
    this.next = (this.next + 1) % this.capacity;
    if (typeof component === 'string' && this.componentSet.size < 200) this.componentSet.add(component);
  };

  /** Newest first. */
  private *newestFirst(): Generator<LogEntry> {
    for (let i = 1; i <= this.capacity; i++) {
      const e = this.ring[(this.next - i + this.capacity) % this.capacity];
      if (!e) return;
      yield e;
    }
  }

  query(q: LogQuery = {}): LogPage {
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
    const min = q.level ? RANK[q.level] : 0;
    const text = q.q?.toLowerCase();
    const matches = (e: LogEntry) =>
      RANK[e.level] >= min
      && (!q.component || e.component === q.component)
      && (!q.requestId || e.requestId === q.requestId)
      && (!q.providerId || e.providerId === q.providerId)
      && (!q.userId || e.userId === q.userId)
      && (!text || e.msg.toLowerCase().includes(text) || JSON.stringify(e.fields).toLowerCase().includes(text) || [e.component, e.requestId, e.providerId, e.userId].some((v) => v?.toLowerCase().includes(text)));

    const items: LogEntry[] = [];
    let hasOlder = false;
    for (const e of this.newestFirst()) {
      if (q.before !== undefined && e.seq >= q.before) continue;
      if (q.after !== undefined && e.seq <= q.after) break;
      if (!matches(e)) continue;
      if (items.length === limit) {
        hasOlder = true;
        break;
      }
      items.push(e);
    }
    let oldest: string | null = null;
    for (const e of this.newestFirst()) oldest = e.time;
    return { items, hasOlder, latestSeq: this.seq, oldestTime: oldest, capacity: this.capacity, components: [...this.componentSet].sort() };
  }
}
