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

// SEC-021: provider responses, streaming responses and model metadata. A provider (or anything
// between ClawRouter and it) is untrusted: every adapter gets realistic answers, streams, embeddings
// and model lists with things changed, plus garbage, odd statuses and streams cut at any byte.
// An adapter either returns values of exactly the types the gateway relies on (text is text,
// token counts are non-negative numbers, ids are strings) or fails with a ProviderCallError,
// which the gateway knows how to handle. Never a TypeError, never a negative token count (usage
// drives quotas and spending limits), never a hang.

import { describe, expect, test } from 'bun:test';
import { createDefaultRegistry, parseSse, ProviderCallError, type ChatResponse, type DiscoveredModel, type ProviderAdapter, type StreamEvent, type Usage } from '@clawrouter/providers';
import type { ProviderKind } from '@clawrouter/shared';
import { forAll, mutateText } from './fuzz.ts';
import { ANSWERS, chunked, EMBEDDINGS, exchange, fakeFetch, family, hostileBody, hostileStream, MODEL_LISTS, STREAMS, type Exchange } from './hostile-provider.ts';

const registry = createDefaultRegistry();
const KINDS: ProviderKind[] = ['openai', 'openai_compatible', 'groq', 'openrouter', 'anthropic', 'google'];

const ctx = (x: Exchange) => ({ endpoint: 'https://provider.test/v1', apiKey: 'sk-fuzz-provider-key-0123456789', timeoutMs: 5_000, fetch: fakeFetch(x) });
const REQUEST = { model: 'm', messages: [{ role: 'user' as const, content: 'Hi' }], tools: [{ name: 'weather', parameters: { type: 'object' } }] };

// ---------------------------------------------------------------- what the gateway relies on

const FINISH = new Set(['stop', 'length', 'content_filter', 'tool_use', 'other']);
const count = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

function usageProblems(u: Usage, at: string): string[] {
  const out: string[] = [];
  if (!u || typeof u !== 'object') return [`${at} usage missing`];
  for (const k of ['inputTokens', 'outputTokens', 'totalTokens'] as const) if (!count(u[k])) out.push(`${at} usage.${k} = ${JSON.stringify(u[k])}`);
  if (u.source !== 'provider' && u.source !== 'none') out.push(`${at} usage.source`);
  if (u.costUsd !== undefined && u.costUsd !== null && !(typeof u.costUsd === 'number' && Number.isFinite(u.costUsd) && u.costUsd >= 0)) out.push(`${at} usage.costUsd = ${JSON.stringify(u.costUsd)}`);
  return out;
}

function responseProblems(res: ChatResponse): string[] {
  const out: string[] = [];
  if (typeof res.model !== 'string') out.push(`model is ${typeof res.model}`);
  if (typeof res.content !== 'string') out.push(`content is ${typeof res.content}`);
  if (res.reasoning !== undefined && typeof res.reasoning !== 'string') out.push(`reasoning is ${typeof res.reasoning}`);
  if (!FINISH.has(res.finishReason)) out.push(`finishReason ${String(res.finishReason)}`);
  for (const [i, c] of (res.toolCalls ?? []).entries()) {
    if (typeof c.id !== 'string' || !c.id || typeof c.name !== 'string' || typeof c.arguments !== 'string') out.push(`toolCalls[${i}] = ${JSON.stringify(c)}`);
  }
  return [...out, ...usageProblems(res.usage, 'response')];
}

function eventProblems(events: StreamEvent[]): string[] {
  const out: string[] = [];
  const done = events.filter((e) => e.type === 'done');
  if (done.length !== 1 || events.at(-1)?.type !== 'done') out.push(`expected one final done event, got ${events.map((e) => e.type).join(',')}`);
  for (const e of events) {
    if (e.type === 'delta' || e.type === 'reasoning') {
      if (typeof e.text !== 'string') out.push(`${e.type}.text is ${typeof e.text}`);
    } else if (e.type === 'tool_call') {
      if (!Number.isInteger(e.index) || e.index < 0) out.push(`tool_call.index = ${JSON.stringify(e.index)}`);
      for (const k of ['id', 'name', 'arguments'] as const) if (e[k] !== undefined && typeof e[k] !== 'string') out.push(`tool_call.${k} is ${typeof e[k]}`);
    } else if (e.type === 'done') {
      if (!FINISH.has(e.finishReason)) out.push(`done.finishReason ${String(e.finishReason)}`);
      if (e.model !== undefined && typeof e.model !== 'string') out.push(`done.model is ${typeof e.model}`);
      out.push(...usageProblems(e.usage, 'done'));
    } else out.push(`unknown event ${String((e as { type: unknown }).type)}`);
  }
  return out;
}

const KIND_NAMES = new Set(['chat', 'embedding', 'other']);
function modelProblems(models: DiscoveredModel[]): string[] {
  const out: string[] = [];
  if (!Array.isArray(models)) return ['not a list'];
  const positive = (v: unknown) => v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0);
  const price = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
  for (const m of models) {
    if (typeof m.id !== 'string' || !m.id) out.push(`id ${JSON.stringify(m.id)}`);
    if (m.displayName !== null && typeof m.displayName !== 'string') out.push(`displayName is ${typeof m.displayName}`);
    if (!positive(m.contextLength) || !positive(m.maxOutputTokens)) out.push(`limits ${JSON.stringify([m.contextLength, m.maxOutputTokens])}`);
    if (m.kind !== undefined && !KIND_NAMES.has(m.kind)) out.push(`kind ${String(m.kind)}`);
    if ((m.vision !== undefined && typeof m.vision !== 'boolean') || (m.tools !== undefined && typeof m.tools !== 'boolean')) out.push('flags');
    if (m.cost !== undefined && m.cost !== null && !(price(m.cost.inputPerMTok) && price(m.cost.outputPerMTok))) out.push(`cost ${JSON.stringify(m.cost)}`);
  }
  return out;
}

/** Runs a call: it returns, or fails with a ProviderCallError. Anything else is a crash. */
async function settle<T>(call: () => Promise<T>): Promise<T | ProviderCallError> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ProviderCallError) {
      if (/sk-fuzz-provider-key/.test(error.message)) throw new Error('the provider key is in the error message');
      return error;
    }
    throw new Error(`crashed with ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`, { cause: error });
  }
}

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of it) {
    events.push(e);
    if (events.length > 10_000) throw new Error('the stream never ended');
  }
  return events;
}

// ---------------------------------------------------------------- the tests

const adapter = (kind: ProviderKind): ProviderAdapter => registry.get(kind)!;

describe('chat answers', () => {
  test.each(KINDS)('%s', async (kind) => {
    const seeds = ANSWERS[family(kind)];
    await forAll(`answer ${kind}`, 800, (r) => exchange(r, hostileBody(r, r.pick(seeds))), async (x) => {
      const out = await settle(() => adapter(kind).sendRequest(ctx(x), REQUEST));
      if (!(out instanceof ProviderCallError)) expect(responseProblems(out)).toEqual([]);
    });
  });
});

describe('streaming answers', () => {
  test.each(KINDS)('%s', async (kind) => {
    const f = family(kind);
    await forAll(`stream ${kind}`, 800, (r) => exchange(r, hostileStream(r, r.pick(STREAMS[f]), f === 'anthropic'), true), async (x) => {
      const out = await settle(() => collect(adapter(kind).sendStreamingRequest(ctx(x), REQUEST)));
      if (!(out instanceof ProviderCallError)) expect(eventProblems(out)).toEqual([]);
    });
  });
});

describe('embeddings', () => {
  test.each(KINDS.filter((k) => adapter(k).embed))('%s', async (kind) => {
    const seed = family(kind) === 'google' ? EMBEDDINGS.google : EMBEDDINGS.openai;
    await forAll(`embed ${kind}`, 600, (r) => exchange(r, hostileBody(r, seed)), async (x) => {
      const out = await settle(() => adapter(kind).embed!(ctx(x), { model: 'e', input: ['a', 'b'] }));
      if (out instanceof ProviderCallError) return;
      const vectors = out.embeddings.every((v) => Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n)));
      expect([typeof out.model, out.embeddings.length, vectors, usageProblems(out.usage, 'embeddings')]).toEqual(['string', 2, true, []]);
    });
  });
});

describe('model metadata (model lists)', () => {
  test.each(KINDS)('%s', async (kind) => {
    const seed = MODEL_LISTS[family(kind)];
    await forAll(`models ${kind}`, 800, (r) => exchange(r, hostileBody(r, seed)), async (x) => {
      const out = await settle(() => adapter(kind).listModels(ctx(x)));
      if (!(out instanceof ProviderCallError)) expect(modelProblems(out)).toEqual([]);
    });
  });

  test('a provider that always has another page is not followed forever', async () => {
    let calls = 0;
    const endless = (async () => {
      calls += 1;
      return Response.json({ models: [{ name: `models/m${calls}`, supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'more' });
    }) as unknown as typeof fetch;
    const models = await adapter('google').listModels({ endpoint: 'https://provider.test/v1beta', apiKey: 'k', timeoutMs: 1000, fetch: endless });
    expect(calls).toBeLessThanOrEqual(10);
    expect(models.length).toBe(calls);
  });
});

describe('the SSE parser', () => {
  /** Events from one chunk, as the reference: splitting the bytes anywhere must give the same events. */
  test('gives the same events however the bytes are split, and never throws', async () => {
    await forAll('sse split', 1000, (r) => {
      const text = r.bool(0.7) ? hostileStream(r, r.pick([...STREAMS.openai, ...STREAMS.anthropic, ...STREAMS.google]), r.bool()) : mutateText(r, 'event: a\ndata: 1\ndata: 2\r\n\r\n: c\ndata:x\n\n');
      return { text, splits: [chunked(r, text), chunked(r, text)] };
    }, async ({ text, splits }) => {
      const read = async (s: ReadableStream<Uint8Array>) => {
        const out = [];
        for await (const e of parseSse(s)) out.push(e);
        return out;
      };
      const whole = await read(new Response(text).body!);
      for (const s of splits) expect(await read(s)).toEqual(whole);
    });
  });
});
