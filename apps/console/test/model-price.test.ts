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
import type { DiscoveredModelInfo } from '@clawrouter/shared';
import { comparePrices, hasPrice, isFree, sortModels } from '../src/features/models/model-price.ts';

const model = (id: string, cost: DiscoveredModelInfo['cost'], contextLength: number | null = null): DiscoveredModelInfo => ({
  providerModelId: id, displayName: null, contextLength, maxOutputTokens: null, capabilities: ['CHAT'], cost, registered: false,
});
const ids = (rows: DiscoveredModelInfo[]) => rows.map((m) => m.providerModelId);

describe('model prices in the discovery dialog', () => {
  test('free means both prices published and zero; an unknown price is not free', () => {
    expect(isFree({ inputPerMTok: 0, outputPerMTok: 0 })).toBe(true);
    expect(isFree({ inputPerMTok: 0, outputPerMTok: 0.5 })).toBe(false);
    expect(isFree({ inputPerMTok: 0, outputPerMTok: null })).toBe(false);
    expect(isFree(null)).toBe(false);
    expect(hasPrice({ inputPerMTok: null, outputPerMTok: null })).toBe(false);
    expect(hasPrice({ inputPerMTok: 1, outputPerMTok: null })).toBe(true);
  });

  const rows = [
    model('pricey', { inputPerMTok: 8, outputPerMTok: 40 }, 1_000_000),
    model('unknown', null, null),
    model('free-b', { inputPerMTok: 0, outputPerMTok: 0 }, 131_072),
    model('cheap', { inputPerMTok: 0.1, outputPerMTok: 0.5 }, 200_000),
    model('free-a', { inputPerMTok: 0, outputPerMTok: 0 }, 1_000_000),
  ];

  test('price ascending: free first (by id), unknown last', () => {
    expect(ids(sortModels(rows, { columnId: 'price', direction: 'ascending' }))).toEqual(['free-a', 'free-b', 'cheap', 'pricey', 'unknown']);
  });

  test('price descending: most expensive first, unknown still last', () => {
    expect(ids(sortModels(rows, { columnId: 'price', direction: 'descending' }))).toEqual(['pricey', 'cheap', 'free-a', 'free-b', 'unknown']);
    expect(comparePrices(null, { inputPerMTok: 0, outputPerMTok: 0 }, 'descending')).toBeGreaterThan(0);
  });

  test('context sorts with unknown last; no sort keeps the server order', () => {
    expect(ids(sortModels(rows, { columnId: 'ctx', direction: 'descending' }))).toEqual(['free-a', 'pricey', 'cheap', 'free-b', 'unknown']);
    expect(ids(sortModels(rows, null))).toEqual(['pricey', 'unknown', 'free-b', 'cheap', 'free-a']);
  });
});
