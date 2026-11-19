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
import { AppError, parse, v } from '../src/index.ts';

const schema = v.object({
  name: v.string({ min: 2, max: 5 }),
  secret: v.string({ trim: false, min: 1 }),
  tag: v.optional(v.string({ pattern: /^[a-z]+$/ })),
  on: v.optional(v.boolean()),
});

function issues(value: unknown) {
  try {
    parse(schema, value);
  } catch (error) {
    return (error as AppError).details?.issues ?? [];
  }
  return [];
}

describe('validation', () => {
  test('returns typed, trimmed values', () => {
    expect(parse(schema, { name: '  ab ', secret: ' x ', on: true })).toEqual({ name: 'ab', secret: ' x ', tag: undefined, on: true });
  });

  test('reports every problem with its path', () => {
    expect(issues({ name: 'a', tag: 'A1', extra: 1 })).toEqual([
      { path: 'extra', message: 'is not allowed' },
      { path: 'name', message: 'must be at least 2 characters' },
      { path: 'secret', message: 'is required' },
      { path: 'tag', message: 'has an invalid format' },
    ]);
  });

  test('rejects non-objects', () => {
    expect(issues([])).toEqual([{ path: '(body)', message: 'must be an object' }]);
    expect(issues(null)).toEqual([{ path: '(body)', message: 'must be an object' }]);
  });

  test('throws VALIDATION_ERROR', () => {
    expect(() => parse(schema, {})).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
});
