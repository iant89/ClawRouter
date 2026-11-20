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
 * A hostile provider for the SEC-021 fuzz tests: realistic answers, streams, embeddings and
 * model lists of each API family, changed or replaced by garbage, served with odd statuses,
 * content types and Retry-After values, and cut into pieces at any byte.
 */
import { shown } from '@clawrouter/core';
import type { ProviderKind } from '@clawrouter/shared';
import { anyJson, mutate, mutateText, rng, type Rng } from './fuzz.ts';

export type Family = 'openai' | 'anthropic' | 'google';
export const family = (k: ProviderKind): Family => (k === 'anthropic' ? 'anthropic' : k === 'google' ? 'google' : 'openai');
// ---------------------------------------------------------------- realistic answers

export const ANSWERS: Record<Family, readonly unknown[]> = {
  openai: [
    { id: 'c', object: 'chat.completion', model: 'gpt-4o-mini', choices: [{ index: 0, message: { role: 'assistant', content: 'Hi there', reasoning_content: 'thinking' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cost: 0.0001 } },
    { model: 'm', choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"Oslo"}' }, extra_content: { google: { thought_signature: 'sig' } } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } },
  ],
  anthropic: [
    { id: 'msg', type: 'message', model: 'claude', content: [{ type: 'thinking', thinking: 'hm', signature: 's' }, { type: 'text', text: 'Hi' }, { type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: 'Oslo' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 4 } },
  ],
  google: [
    { candidates: [{ content: { role: 'model', parts: [{ text: 'thought', thought: true }, { text: 'Hi' }, { functionCall: { name: 'weather', args: { city: 'Oslo' } }, thoughtSignature: 'sig' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6, thoughtsTokenCount: 1 }, modelVersion: 'gemini-x' },
  ],
};

export const STREAMS: Record<Family, readonly (readonly unknown[])[]> = {
  openai: [
    [{ model: 'm', choices: [{ delta: { role: 'assistant', reasoning: 'r' } }] }, { choices: [{ delta: { content: 'Hel' } }] }, { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }, '[DONE]'],
    [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'weather', arguments: '' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] }, finish_reason: 'tool_calls' }], x_groq: { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } }, '[DONE]'],
  ],
  anthropic: [[
    { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'weather', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":"Oslo"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
    { type: 'ping' },
    { type: 'message_stop' },
  ]],
  google: [[
    { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }] } }] },
    { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] },
    { candidates: [{ content: { parts: [{ text: 'lo' }, { functionCall: { name: 'weather', args: {} } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }, modelVersion: 'gemini-x' },
  ]],
};

export const EMBEDDINGS = {
  openai: { model: 'e', data: [{ index: 1, embedding: [0.3, 0.4] }, { index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 2, total_tokens: 2 } },
  google: { embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] },
} as const;

export const MODEL_LISTS = {
  openai: { object: 'list', data: [
    { id: 'gpt-4o-mini', object: 'model', owned_by: 'openai' },
    { id: 'openai/gpt-oss-20b', name: 'GPT OSS', active: true, context_window: 131072, max_completion_tokens: 32768, supported_features: ['tools'], input_modalities: ['text', 'image'], output_modalities: ['text'], pricing: { prompt: '0.0000001', completion: '0.0000005' } },
    { id: 'x/y:free', name: 'Free', context_length: 8192, top_provider: { context_length: 8192, max_completion_tokens: 1024 }, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools', 'max_tokens'], endpoints: ['/api/v1/chat/completions'], expiration_date: '2099-01-01', pricing: { prompt: '0', completion: '0' } },
    { id: 'models/gemini-embedding-001', display_name: 'Gemini Embedding' },
  ] },
  anthropic: { data: [{ id: 'claude-sonnet', display_name: 'Claude Sonnet', type: 'model' }], has_more: false, first_id: 'claude-sonnet', last_id: 'claude-sonnet' },
  google: { models: [
    { name: 'models/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-embedding-001', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
  ] },
} as const;

// ---------------------------------------------------------------- a hostile provider

const STATUSES = [200, 200, 200, 200, 200, 200, 201, 204, 206, 301, 302, 400, 401, 403, 404, 408, 413, 429, 500, 502, 503, 529];
const TYPES = ['application/json', 'application/json', 'text/event-stream', 'text/html', 'text/plain', '', 'application/octet-stream'];

/** A body: a changed realistic one most of the time, else noise. */
export function hostileBody(r: Rng, valid: unknown): string {
  const roll = r.int(10);
  if (roll < 6) return JSON.stringify(mutate(r, valid));
  if (roll === 6) return mutateText(r, JSON.stringify(valid));
  if (roll === 7) return JSON.stringify(anyJson(r, 4));
  if (roll === 8) return r.pick(['', 'null', '[]', '{}', '"x"', '0', 'true', '<html>502 Bad Gateway</html>', '{"error":{"message":{"toString":1}}}', '[{"error":{"message":"API key not valid"}}]', '{"error":"x"}']);
  return JSON.stringify(valid);
}

/** SSE text for a list of event payloads, with optional event names (Anthropic sends them). */
export function sse(r: Rng, events: readonly unknown[], named: boolean): string {
  let out = '';
  for (const e of events) {
    if (r.bool(0.05)) out += ': keep-alive\n\n';
    const data = typeof e === 'string' ? e : JSON.stringify(e);
    const name = named && e && typeof e === 'object' && 'type' in e ? `event: ${shown((e as { type: unknown }).type).replace(/[\r\n]/g, '')}\n` : '';
    out += `${name}data: ${data}${r.bool(0.1) ? '\r\n\r\n' : '\n\n'}`;
  }
  return out;
}

export function hostileStream(r: Rng, valid: readonly unknown[], named: boolean): string {
  const roll = r.int(8);
  if (roll < 4) return sse(r, valid.map((e) => (r.bool(0.3) ? mutate(r, e) : e)), named);
  if (roll === 4) return mutateText(r, sse(r, valid, named));
  if (roll === 5) return sse(r, Array.from({ length: r.int(6) }, () => anyJson(r, 3)), named);
  if (roll === 6) return r.pick(['', 'data: [DONE]\n\n', 'data: {"type":"error","error":{"message":5}}\n\n', 'data: null\n\n', 'data:\n\n', 'event: x\n', 'data: '.repeat(50), '\n\n\n', 'retry: 1\nid: 2\n\n', ': only a comment']);
  return sse(r, valid.slice(0, r.int(valid.length + 1)), named);
}

/** Bytes split at random places (a multi-byte character may be cut in two). */
export function chunked(r: Rng, text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const parts: Uint8Array[] = [];
  for (let at = 0; at < bytes.length;) {
    const len = 1 + r.int(r.bool(0.3) ? 4 : 200);
    parts.push(bytes.slice(at, at + len));
    at += len;
  }
  return new ReadableStream({
    pull(controller) {
      const next = parts.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
  });
}

/** One provider answer. `split` (a seed) cuts the body into random pieces; null sends it whole. */
export interface Exchange { status: number; type: string; body: string; split: number | null; retryAfter: string | null }

export function exchange(r: Rng, body: string, streamed = false): Exchange {
  return {
    status: r.bool(0.75) ? 200 : r.pick(STATUSES),
    type: r.bool(0.8) ? (streamed ? 'text/event-stream' : 'application/json') : r.pick(TYPES),
    body,
    split: r.bool(0.5) ? r.int(2 ** 31) : null,
    retryAfter: r.bool(0.2) ? r.pick(['1', '0', '-5', '99999999', 'soon', 'Wed, 21 Oct 2015 07:28:00 GMT', '1e9', '']) : null,
  };
}

export const fakeFetch = (x: Exchange): typeof fetch => (async () => {
  const headers: Record<string, string> = {};
  if (x.type) headers['content-type'] = x.type;
  if (x.retryAfter !== null) headers['retry-after'] = x.retryAfter;
  if (x.status >= 300 && x.status < 400) headers.location = 'https://elsewhere.test/';
  return new Response(x.status === 204 ? null : x.split === null ? x.body : chunked(rng(x.split), x.body), { status: x.status, headers });
}) as unknown as typeof fetch;

