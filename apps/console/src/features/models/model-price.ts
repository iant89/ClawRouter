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

import type { DiscoveredModelInfo } from '@clawrouter/shared';

/** Prices per million tokens, as a provider publishes them (either may be unknown). */
export type ListedPrice = { inputPerMTok: number | null; outputPerMTok: number | null } | null | undefined;

/** Free: both prices published and both zero. An unknown price is never "free". */
export const isFree = (cost: ListedPrice): boolean => cost?.inputPerMTok === 0 && cost.outputPerMTok === 0;

/** Some price is published (otherwise the provider does not say). */
export const hasPrice = (cost: ListedPrice): boolean => cost != null && (cost.inputPerMTok !== null || cost.outputPerMTok !== null);

/**
 * What sorting by price compares: input plus output per million tokens, a rough
 * "how expensive" that orders free first. Unknown prices have no place on that
 * scale, so they sort after every known price, in both directions.
 */
export function comparePrices(a: ListedPrice, b: ListedPrice, direction: 'ascending' | 'descending' = 'ascending'): number {
  const known = (c: ListedPrice) => hasPrice(c);
  if (known(a) !== known(b)) return known(a) ? -1 : 1;
  if (!known(a)) return 0;
  const total = (c: ListedPrice) => (c?.inputPerMTok ?? 0) + (c?.outputPerMTok ?? 0);
  const diff = total(a) - total(b);
  return direction === 'ascending' ? diff : -diff;
}

/**
 * Rows in the chosen order. Sorted here rather than by the table, so models without
 * a published price or context stay at the bottom in both directions.
 */
export function sortModels(rows: DiscoveredModelInfo[], sort: { columnId: string; direction: 'ascending' | 'descending' } | null): DiscoveredModelInfo[] {
  if (!sort) return rows;
  const dir = sort.direction === 'ascending' ? 1 : -1;
  const unknownLast = (a: number | null, b: number | null) => (a === null) !== (b === null) ? (a === null ? 1 : -1) : a === null || b === null ? 0 : (a - b) * dir;
  const compare: Record<string, (a: DiscoveredModelInfo, b: DiscoveredModelInfo) => number> = {
    id: (a, b) => a.providerModelId.localeCompare(b.providerModelId) * dir,
    ctx: (a, b) => unknownLast(a.contextLength, b.contextLength),
    price: (a, b) => comparePrices(a.cost, b.cost, sort.direction),
  };
  const fn = compare[sort.columnId];
  // Equal prices or contexts are ordered by model id, so the list does not jump around.
  return fn ? [...rows].sort((a, b) => fn(a, b) || a.providerModelId.localeCompare(b.providerModelId)) : rows;
}
