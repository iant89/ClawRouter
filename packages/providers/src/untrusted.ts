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
 * Reading provider JSON, which is untrusted input (SEC-021, SEC-036). A provider, a proxy in
 * between or a bug can send any JSON at any place: `null` for the body, a number where text
 * belongs, an object where a list belongs, negative token counts. Adapters read every field
 * through these helpers, so a wrong type becomes "absent" (or the call fails with
 * `invalid_response`) instead of a TypeError, and only values of the expected type reach
 * the gateway. Token counts feed quotas and spending limits: a negative one would give
 * spending back, so anything but a finite number >= 0 is "not reported".
 */

export type Json = Record<string, unknown>;

/** A JSON object (not null, not a list), or null. */
export const obj = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null);

/** A list, or an empty one. */
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The objects in a list; anything else in it is left out. */
export const objects = (v: unknown): Json[] => list(v).map(obj).filter((o): o is Json => o !== null);

/** Text, or undefined. */
export const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** A token count: a finite number >= 0, else null (not reported). */
export const tokens = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** A list of finite numbers (an embedding vector), or null. */
export const vector = (v: unknown): number[] | null =>
  Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? (v as number[]) : null;
