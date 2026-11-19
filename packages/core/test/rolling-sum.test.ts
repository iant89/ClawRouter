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

import { describe, expect, test } from 'bun:test';
import { RollingSum } from '../src/index.ts';

describe('RollingSum', () => {
  test('sums the last window, to the bucket', () => {
    const r = new RollingSum(1_000, 60); // the last minute in seconds
    const t0 = Date.parse('2026-11-14T00:00:00.000Z');
    r.add(t0);
    r.add(t0 + 500, 2);
    r.add(t0 + 30_000);
    expect(r.sum(t0 + 30_000)).toBe(4);
    expect(r.sum(t0 + 59_999)).toBe(4);
    expect(r.sum(t0 + 60_000)).toBe(1); // the first second's bucket has left the window
    expect(r.sum(t0 + 90_000)).toBe(0);
  });

  test('reused slots start again from zero; memory stays fixed', () => {
    const r = new RollingSum(1_000, 3);
    for (let s = 0; s < 10_000; s++) r.add(s * 1_000, 5);
    expect(r.sum(9_999_000)).toBe(15);
    // A query for an earlier time ignores buckets from its future.
    expect(r.sum(9_997_000)).toBe(5);
  });
});
