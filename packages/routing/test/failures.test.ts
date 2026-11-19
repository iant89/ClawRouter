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
import { FailureTracker } from '../src/index.ts';

describe('FailureTracker', () => {
  test('counts failures inside the window; success clears them', () => {
    let t = 0;
    const f = new FailureTracker(1000, () => t);
    f.recordFailure('p');
    t = 500;
    f.recordFailure('p');
    expect(f.count('p')).toBe(2);
    t = 1200; // the first one expired
    expect(f.count('p')).toBe(1);
    f.recordSuccess('p');
    expect(f.count('p')).toBe(0);
    expect(f.count('other')).toBe(0);
  });
});
