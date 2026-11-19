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

/**
 * Recent provider failures (spec §10 "failure history"). In memory and per
 * process; the gateway (phase 8) records outcomes and the engine demotes
 * providers that keep failing. A later phase can back this with Redis.
 */
export class FailureTracker {
  private readonly events = new Map<string, number[]>();

  constructor(
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  recordFailure(providerId: string): void {
    const list = this.prune(providerId);
    list.push(this.now());
    this.events.set(providerId, list);
  }

  /** A success clears the history: the provider is working again. */
  recordSuccess(providerId: string): void {
    this.events.delete(providerId);
  }

  /** Failures within the window. */
  count(providerId: string): number {
    return this.prune(providerId).length;
  }

  private prune(providerId: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.events.get(providerId) ?? []).filter((t) => t > cutoff);
    if (list.length) this.events.set(providerId, list);
    else this.events.delete(providerId);
    return list;
  }
}
