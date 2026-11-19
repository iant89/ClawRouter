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
 * A sum over a sliding time window, kept as `slots` fixed buckets of `bucketMs`
 * each: constant memory and time whatever the request rate (phase 16: lists with
 * one entry per request grew without bound under load). Accurate to one bucket.
 */
export class RollingSum {
  private readonly keys: Float64Array;
  private readonly sums: Float64Array;

  constructor(private readonly bucketMs: number, private readonly slots: number) {
    this.keys = new Float64Array(slots).fill(Number.NaN);
    this.sums = new Float64Array(slots);
  }

  add(at: number, value = 1): void {
    const key = Math.floor(at / this.bucketMs);
    const i = key % this.slots;
    if (this.keys[i] !== key) {
      this.keys[i] = key;
      this.sums[i] = 0;
    }
    this.sums[i]! += value;
  }

  sum(at: number): number {
    const key = Math.floor(at / this.bucketMs);
    let total = 0;
    for (let i = 0; i < this.slots; i++) {
      const k = this.keys[i]!;
      if (k <= key && key - k < this.slots) total += this.sums[i]!;
    }
    return total;
  }
}

