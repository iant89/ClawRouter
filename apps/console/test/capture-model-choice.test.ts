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
import { ALL_MODELS, describeModels, modelsToSend, nextModelChoice } from '../src/features/captures/model-choice.ts';

describe('manual capture model choice', () => {
  test('All and particular models exclude each other, and nothing chosen falls back to All', () => {
    expect(nextModelChoice([ALL_MODELS], [ALL_MODELS, 'a/x'])).toEqual(['a/x']); // a model clears All
    expect(nextModelChoice(['a/x'], ['a/x', 'a/y'])).toEqual(['a/x', 'a/y']);
    expect(nextModelChoice(['a/x', 'a/y'], ['a/x', 'a/y', ALL_MODELS])).toEqual([ALL_MODELS]); // All clears the models
    expect(nextModelChoice(['a/x'], [])).toEqual([ALL_MODELS]); // last model cleared
    expect(nextModelChoice([ALL_MODELS], [])).toEqual([ALL_MODELS]); // All cannot be cleared on its own
  });

  test('All is sent as null', () => {
    expect(modelsToSend([ALL_MODELS])).toBeNull();
    expect(modelsToSend(['a/x', 'a/y'])).toEqual(['a/x', 'a/y']);
  });

  test('the banner names up to three models', () => {
    expect(describeModels(['a'])).toBe('a');
    expect(describeModels(['a', 'b'])).toBe('a and b');
    expect(describeModels(['a', 'b', 'c'])).toBe('a, b and c');
    expect(describeModels(['a', 'b', 'c', 'd'])).toBe('4 models');
  });
});
