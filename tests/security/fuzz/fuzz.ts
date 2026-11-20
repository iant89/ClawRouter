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
 * A small, seeded fuzzer for the SEC-021 tests. No dependency: a fixed pseudo-random
 * generator, generators for hostile JSON and text, and mutations of valid inputs (most
 * findings come from a valid request with one thing wrong, not from noise).
 *
 * Runs are reproducible. Every test has its own fixed seed, so CI always runs the same
 * cases; `FUZZ_SEED=<n>` explores other ones and `FUZZ_RUNS=<factor>` runs more of them
 * (`FUZZ_RUNS=20 FUZZ_SEED=$RANDOM bun run test:fuzz`). A failure names the seed and
 * the case, and prints the input.
 */
import { AppError } from '@clawrouter/core';
import type { LogRecord } from '@clawrouter/core';

export type Rng = {
  /** 0 <= x < 1 */
  next(): number;
  int(maxExclusive: number): number;
  bool(p?: number): boolean;
  pick<T>(items: readonly T[]): T;
};

/** mulberry32: small, fast, good enough to spread cases. */
export function rng(seed: number): Rng {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (max) => Math.floor(next() * max),
    bool: (p = 0.5) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)]!,
  };
}

const ENV_SEED = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : null;
const FACTOR = Math.max(1, Number(process.env.FUZZ_RUNS ?? '1') || 1);

/** A stable seed per test name, or FUZZ_SEED mixed with the name. */
export function seedFor(name: string): number {
  let h = ENV_SEED ?? 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export const runs = (n: number) => n * FACTOR;

const preview = (value: unknown) => {
  let text: string;
  try {
    text = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 2000 ? `${text.slice(0, 2000)}… (${text.length} characters)` : text;
};

/** Longest one case may take: a hang on hostile input is a finding (a client or provider holding the server). */
export const CASE_TIMEOUT_MS = 5_000;

/**
 * Runs `property` on `count` generated inputs. Throws on the first failing case with
 * the seed, the case number and the input, so it can be turned into a regression test.
 * A case that takes longer than `CASE_TIMEOUT_MS` fails as a hang.
 */
export async function forAll<T>(name: string, count: number, generate: (r: Rng, i: number) => T, property: (input: T, i: number) => void | Promise<void>): Promise<void> {
  const seed = seedFor(name);
  const r = rng(seed);
  const total = runs(count);
  for (let i = 0; i < total; i++) {
    const input = generate(r, i);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const hang = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`did not finish within ${CASE_TIMEOUT_MS} ms (a hang)`)), CASE_TIMEOUT_MS); });
      await Promise.race([Promise.resolve().then(() => property(input, i)), hang]);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(`fuzz "${name}" failed (seed ${seed}, case ${i} of ${total}): ${why}\ninput: ${preview(input)}`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------- values

/** Strings that tend to break parsers, encoders, databases and log lines. */
export const NASTY_STRINGS: readonly string[] = [
  '', ' ', '\u0000', '\u0000abc', 'a\u0000b', '\n', '\r\n', '\t', '\u001b[31mred', '\u007f', '  ',
  '\ud800', '\udfff', '\ud83d', '😀', '👩‍👩‍👧‍👦', '‮', '﻿', '￿', 'Ω≈ç√∫', 'ﷺ', '𝕏',
  '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf',
  'null', 'undefined', 'NaN', 'true', '0', '-1', '1e309', '0x10', '[]', '{}', '"', '\\', '\\u0000', '%00', '%s%s%n',
  '../../../../etc/passwd', '..\\..\\windows', '/dev/zero', 'file:///etc/passwd', 'http://169.254.169.254/latest',
  "'; DROP TABLE users; --", "' OR '1'='1", '<script>alert(1)</script>', '${process.env}', '{{7*7}}', '$(id)', '`id`',
  'data:text/plain;base64,QUJD', 'data:image/png;base64,', 'data:image/png;base64,!!!', 'crk_00000000_xxxx',
  'gpt-4o-mini', 'openai/gpt-4o-mini', 'system', 'user', 'assistant', 'tool', 'function', 'developer', 'auto', 'none', 'required',
  'a'.repeat(10_000),
];

export const NASTY_NUMBERS: readonly number[] = [
  0, -0, 1, -1, 0.5, -0.5, 2, 7, 255, 256, 65535, 65536, 2 ** 31 - 1, 2 ** 31, -(2 ** 31), 2 ** 32,
  Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2, -Number.MAX_SAFE_INTEGER, Number.MAX_VALUE, Number.MIN_VALUE, 1e21, 1e-7, 3.14159,
];

export function anyString(r: Rng): string {
  if (r.bool(0.4)) return r.pick(NASTY_STRINGS);
  const len = r.pick([0, 1, 2, 5, 16, 64, 300]);
  let s = '';
  for (let i = 0; i < len; i++) {
    const roll = r.next();
    s += roll < 0.7 ? String.fromCharCode(32 + r.int(95)) : roll < 0.85 ? String.fromCharCode(r.int(32)) : String.fromCharCode(r.int(0x10000));
  }
  return s;
}

export function anyNumber(r: Rng): number {
  return r.bool(0.6) ? r.pick(NASTY_NUMBERS) : (r.next() - 0.5) * 10 ** r.int(12);
}

/** Any JSON value, up to `depth` levels deep. */
export function anyJson(r: Rng, depth = 3): unknown {
  const roll = r.int(depth > 0 ? 8 : 5);
  switch (roll) {
    case 0: return null;
    case 1: return r.bool();
    case 2: return anyNumber(r);
    case 3:
    case 4: return anyString(r);
    case 5:
    case 6: return Array.from({ length: r.pick([0, 1, 2, 3, 8]) }, () => anyJson(r, depth - 1));
    default: {
      const o: Record<string, unknown> = {};
      for (let i = r.pick([0, 1, 2, 4]); i > 0; i--) o[r.bool(0.7) ? anyKey(r) : anyString(r)] = anyJson(r, depth - 1);
      return o;
    }
  }
}

const COMMON_KEYS = ['id', 'type', 'name', 'role', 'content', 'text', 'data', 'model', 'messages', 'input', 'value', 'values', 'items', 'error', 'message', 'arguments', 'params', 'method', 'result', 'usage', 'choices', 'delta', 'tools', '__proto__', 'constructor'];
const anyKey = (r: Rng) => r.pick(COMMON_KEYS);

// ---------------------------------------------------------------- mutations

type Path = (string | number)[];

function paths(value: unknown, at: Path = [], out: Path[] = []): Path[] {
  out.push(at);
  if (Array.isArray(value)) value.forEach((v, i) => paths(v, [...at, i], out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) paths(v, [...at, k], out);
  return out;
}

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** A replacement for `old`: often a value of the wrong type, sometimes a near miss of the right one. */
function replacementFor(r: Rng, old: unknown): unknown {
  if (r.bool(0.5)) return anyJson(r, 2);
  if (typeof old === 'string') return r.pick([old + anyString(r), old.slice(0, r.int(old.length + 1)), old.toUpperCase(), ` ${old}`, old.repeat(1 + r.int(3)), '', anyString(r)]);
  if (typeof old === 'number') return r.pick([-old, old + 1, old - 1, old * 1000, old / 3, anyNumber(r), String(old)]);
  if (typeof old === 'boolean') return r.pick([!old, String(old), old ? 1 : 0, null]);
  if (Array.isArray(old)) return r.pick([[], [...old, ...old], old.slice(1), [old], Object.fromEntries(old.map((v, i) => [i, v]))]);
  if (old && typeof old === 'object') return r.pick([{}, [old], Object.values(old), JSON.stringify(old)]);
  return anyJson(r, 1);
}

/** One structural change to a copy of `value`: replace, delete, add, duplicate or wrap something. */
export function mutate(r: Rng, value: unknown, times = 1 + r.int(3)): unknown {
  let doc = clone(value);
  for (let t = 0; t < times; t++) {
    const all = paths(doc);
    const path = r.pick(all);
    if (path.length === 0) {
      doc = r.bool(0.8) ? replacementFor(r, doc) : [doc];
      continue;
    }
    const parentPath = path.slice(0, -1);
    const key = path[path.length - 1]!;
    let parent: unknown = doc;
    for (const p of parentPath) parent = (parent as Record<string | number, unknown>)[p];
    const box = parent as Record<string | number, unknown>;
    const action = r.int(6);
    if (action === 0) {
      if (Array.isArray(box)) box.splice(key as number, 1);
      else delete box[key];
    } else if (action === 1 && !Array.isArray(box)) {
      box[r.bool(0.5) ? anyKey(r) : anyString(r)] = anyJson(r, 2);
    } else if (action === 2 && Array.isArray(box)) {
      box.splice(key as number, 0, ...Array.from({ length: 1 + r.int(r.bool(0.1) ? 200 : 3) }, () => clone(box[key as number])));
    } else {
      box[key] = replacementFor(r, box[key]);
    }
  }
  return doc;
}

/** Byte-level damage to text: truncation, flipped and inserted characters, repeated slices. */
export function mutateText(r: Rng, text: string, times = 1 + r.int(4)): string {
  let s = text;
  for (let t = 0; t < times; t++) {
    const at = r.int(s.length + 1);
    switch (r.int(6)) {
      case 0: s = s.slice(0, at); break;
      case 1: s = s.slice(0, at) + String.fromCharCode(r.int(r.bool(0.8) ? 128 : 0x10000)) + s.slice(at + 1); break;
      case 2: s = s.slice(0, at) + r.pick(['{', '}', '[', ']', '"', ',', ':', '\\', '\n', '\u0000', 'null', '1e999', '-', '\ud800', ' ']) + s.slice(at); break;
      case 3: { const len = r.int(40); s = s.slice(0, at) + s.slice(at, at + len).repeat(2 + r.int(3)) + s.slice(at + len); break; }
      case 4: s = s.slice(0, at) + s.slice(at + 1 + r.int(20)); break;
      default: s = s.slice(0, at) + anyString(r) + s.slice(at);
    }
  }
  return s;
}

/** A hostile JSON text: valid but odd, deep, wide, or broken. */
export function hostileJsonText(r: Rng, seed?: unknown): string {
  switch (r.int(9)) {
    case 0: return '['.repeat(1 + r.int(5000)) + ']'.repeat(r.int(5000));
    case 1: return '{"a":'.repeat(1 + r.int(3000)) + '1' + '}'.repeat(r.int(3000));
    case 2: return `{${Array.from({ length: 1 + r.int(2000) }, (_, i) => `"k${i}":${i}`).join(',')}}`;
    case 3: return '{"__proto__":{"admin":true},"constructor":{"prototype":{"polluted":1}}}';
    case 4: return '{"a":1,"a":2,"model":"x","model":{"$gt":""}}';
    case 5: return r.pick(['', ' ', 'null', 'true', '0', '"x"', '[]', '{}', '﻿{}', '{}\u0000', '1e999', '-0', '{"a":"\\ud800"}', 'NaN', '{"a":undefined}', "{'a':1}", '{"a":1,}', '[1,]', '\u0000']);
    case 6: return mutateText(r, JSON.stringify(seed ?? anyJson(r, 3)));
    case 7: return JSON.stringify(anyJson(r, 4));
    default: return JSON.stringify(mutate(r, seed ?? anyJson(r, 3)));
  }
}

// ---------------------------------------------------------------- properties

/** Calls a validator: it may return, or refuse with a client error (4xx AppError). Anything else is a bug. */
export function expectClientError(fn: () => unknown): unknown {
  try {
    return fn();
  } catch (error) {
    if (error instanceof AppError && error.status >= 400 && error.status < 500) return error;
    throw new Error(`threw ${error instanceof AppError ? `${error.code} (${error.status})` : error instanceof Error ? `${error.name}: ${error.message}` : String(error)} instead of a client error`, { cause: error });
  }
}

export async function expectClientErrorAsync(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AppError && error.status >= 400 && error.status < 500) return error;
    throw new Error(`threw ${error instanceof AppError ? `${error.code} (${error.status})` : error instanceof Error ? `${error.name}: ${error.message}` : String(error)} instead of a client error`, { cause: error });
  }
}

/** Text that only appears when internals escape: stack frames, source paths, the error class names of the runtime. */
const LEAK = /\n\s+at\s|\bat .*\.ts:\d+|\/home\/|node_modules|TypeError|RangeError|SyntaxError|ReferenceError|SQLITE_|bun:sqlite/;

/**
 * An HTTP answer to hostile input: never a 500, always JSON (or an event stream), and
 * nothing internal in the body. `allow` lists other acceptable statuses (e.g. 502 when a
 * provider sent garbage).
 */
export async function expectHandledResponse(res: Response, logs: LogRecord[], allow: number[] = []): Promise<string> {
  const text = await res.text();
  const failed = logs.filter((l) => l.msg === 'request failed' && l.code === 'INTERNAL_ERROR');
  if (failed.length) throw new Error(`the server logged an internal error: ${String((failed[0]!.error as { message?: string })?.message ?? failed[0]!.error)}`);
  // A provider adapter that throws anything but a ProviderCallError is classified "internal": a crash, not a provider problem.
  const crashed = logs.filter((l) => (l.msg === 'gateway attempt failed' && l.kind === 'internal') || (l.msg === 'stream ended with an error' && LEAK.test(String(l.error))));
  if (crashed.length) throw new Error(`a provider call crashed: ${String(crashed[0]!.error)}`);
  if (res.status >= 500 && !allow.includes(res.status)) throw new Error(`answered ${res.status}: ${text.slice(0, 300)}`);
  if (LEAK.test(text)) throw new Error(`the answer shows internals: ${text.slice(0, 500)}`);
  const type = res.headers.get('content-type') ?? '';
  if (text && !/json|event-stream/.test(type)) throw new Error(`answered ${type || 'no content type'}: ${text.slice(0, 200)}`);
  if (/json/.test(type)) JSON.parse(text);
  return text;
}
