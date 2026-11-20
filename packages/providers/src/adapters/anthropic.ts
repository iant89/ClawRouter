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

import type { ProviderKindInfo } from '@clawrouter/shared';
import { invalidResponse, joinUrl, parseChunk, ProviderCallError, providerFetch, readJson } from '../http.ts';
import { obj, objects, text, tokens, type Json } from '../untrusted.ts';
import { parseSse } from '../sse.ts';
import type { ChatMessage, ChatRequest, MessagePart, ToolChoice, ChatResponse, FinishReason, ProviderAdapter, ProviderCallContext, StreamEvent, Usage } from '../types.ts';
import { baseValidation, connectionChecks, splitSystem } from './common.ts';

const API_VERSION = '2023-06-01';
/** The Messages API requires max_tokens; used when the client sets none. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

const finish = (reason: unknown): FinishReason =>
  reason === 'end_turn' || reason === 'stop_sequence' ? 'stop' : reason === 'max_tokens' ? 'length' : reason === 'tool_use' ? 'tool_use' : reason === 'refusal' ? 'content_filter' : 'other';

const usage = (input: number | null, output: number | null): Usage => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input !== null && output !== null ? input + output : null,
  source: input !== null || output !== null ? 'provider' : 'none',
});

const info: ProviderKindInfo = {
  kind: 'anthropic',
  displayName: 'Anthropic',
  description: 'Anthropic Messages API (Claude models).',
  defaultEndpoint: 'https://api.anthropic.com',
  endpointRequired: false,
  apiKeyRequired: true,
  capabilities: ['CHAT', 'CODING', 'REASONING', 'VISION', 'TOOL_USE'],
  supportsStreaming: true,
  // Images by URL or inline, PDFs inline (as a document block). No audio.
  inputMedia: ['image_url', 'image_data', 'pdf'],
};

const headers = (ctx: ProviderCallContext): Record<string, string> => ({
  'content-type': 'application/json',
  accept: 'application/json',
  'anthropic-version': API_VERSION,
  ...(ctx.apiKey ? { 'x-api-key': ctx.apiKey } : {}),
});

/** A message part as an Anthropic content block. Audio never reaches here (not in inputMedia). */
function anthropicBlock(p: MessagePart): Record<string, unknown> {
  switch (p.type) {
    case 'text': return { type: 'text', text: p.text };
    case 'image': return { type: 'image', source: p.source.kind === 'url' ? { type: 'url', url: p.source.url } : { type: 'base64', media_type: p.source.mediaType, data: p.source.data } };
    case 'pdf': return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.data }, ...(p.filename ? { title: p.filename } : {}) };
    case 'audio': throw new Error('Anthropic does not accept audio');
  }
}

/** JSON arguments as an object (Anthropic wants `input` as an object, not text). */
function parseArguments(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text || '{}');
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { arguments: text };
  }
}

/**
 * Messages as Anthropic content blocks. Tool calls become `tool_use` blocks in the
 * assistant turn; tool results become `tool_result` blocks in a user turn, and
 * results that follow each other share one turn, as Anthropic requires.
 */
function anthropicMessages(messages: ChatMessage[]): { role: 'user' | 'assistant'; content: unknown }[] {
  const out: { role: 'user' | 'assistant'; content: unknown }[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
      const last = out.at(-1);
      if (last?.role === 'user' && Array.isArray(last.content) && (last.content as { type?: string }[]).every((b) => b.type === 'tool_result')) {
        (last.content as unknown[]).push(block);
      } else out.push({ role: 'user', content: [block] });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: parseArguments(c.arguments) })),
        ],
      });
      continue;
    }
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.parts ? m.parts.map(anthropicBlock) : m.content });
  }
  return out;
}

function anthropicToolChoice(choice: ToolChoice | undefined, parallel: boolean | undefined): Record<string, unknown> {
  const noParallel = parallel === false ? { disable_parallel_tool_use: true } : {};
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any', ...noParallel };
  if (typeof choice === 'object') return { type: 'tool', name: choice.name, ...noParallel };
  return { type: 'auto', ...noParallel };
}

function body(req: ChatRequest, stream: boolean) {
  const { system, rest } = splitSystem(req.messages);
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages: anthropicMessages(rest),
    ...(req.tools?.length ? { tools: req.tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), input_schema: t.parameters ?? { type: 'object', properties: {} } })) } : {}),
    ...(req.tools?.length && (req.toolChoice !== undefined || req.parallelToolCalls === false) ? { tool_choice: anthropicToolChoice(req.toolChoice, req.parallelToolCalls) } : {}),
    ...(system ? { system } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    ...(req.stop?.length ? { stop_sequences: req.stop } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

async function listModels(ctx: ProviderCallContext) {
  const res = await providerFetch(ctx, joinUrl(ctx.endpoint, '/v1/models?limit=100'), { method: 'GET', headers: headers(ctx) });
  const json = await readJson(res, ctx.apiKey);
  if (!Array.isArray(json.data)) throw invalidResponse('model list has no "data" array');
  return objects(json.data)
    .filter((m): m is Json & { id: string } => typeof m.id === 'string' && m.id !== '')
    .map((m) => ({ id: m.id, displayName: text(m.display_name) ?? null, kind: 'chat' as const }));
}

/** Anthropic's usage block: `input_tokens`, `output_tokens` (counts of the wrong type are "not reported"). */
const usageBlock = (value: unknown) => {
  const u = obj(value);
  return { input: tokens(u?.input_tokens), output: tokens(u?.output_tokens) };
};

export const anthropicAdapter: ProviderAdapter = {
  info,
  capabilities: info.capabilities,
  validateConfiguration: (config) => baseValidation(config, true),
  listModels,
  ...connectionChecks(listModels),

  async sendRequest(ctx, req): Promise<ChatResponse> {
    const res = await providerFetch(ctx, joinUrl(ctx.endpoint, '/v1/messages'), { method: 'POST', headers: headers(ctx), body: JSON.stringify(body(req, false)) });
    const json = await readJson(res, ctx.apiKey);
    if (!Array.isArray(json.content)) throw invalidResponse('no content in response');
    const blocks = objects(json.content);
    const content = blocks.filter((b) => b.type === 'text').map((b) => text(b.text) ?? '').join('');
    const toolCalls = blocks.filter((b) => b.type === 'tool_use' && text(b.id) && typeof b.name === 'string')
      .map((b) => ({ id: b.id as string, name: b.name as string, arguments: JSON.stringify(b.input ?? {}) }));
    const reasoning = blocks.filter((b) => b.type === 'thinking' && typeof b.thinking === 'string').map((b) => b.thinking as string).join('\n\n');
    const used = usageBlock(json.usage);
    return {
      model: text(json.model) || req.model, content, finishReason: finish(json.stop_reason), usage: usage(used.input, used.output),
      ...(reasoning ? { reasoning } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  },

  async *sendStreamingRequest(ctx, req): AsyncGenerator<StreamEvent> {
    const res = await providerFetch(ctx, joinUrl(ctx.endpoint, '/v1/messages'), {
      method: 'POST', headers: { ...headers(ctx), accept: 'text/event-stream' }, body: JSON.stringify(body(req, true)),
    });
    if (!res.body) throw invalidResponse('empty stream');
    let model = req.model;
    let input: number | null = null;
    let output: number | null = null;
    const toolIndex = new Map<number, number>();
    let reason: FinishReason = 'other';
    for await (const event of parseSse(res.body, ctx.signal)) {
      const data = parseChunk(event.data, 'malformed stream event');
      const index = typeof data.index === 'number' && Number.isInteger(data.index) ? data.index : null;
      const delta = obj(data.delta);
      switch (data.type) {
        case 'message_start': {
          const message = obj(data.message);
          const used = usageBlock(message?.usage);
          model = text(message?.model) || model;
          input = used.input ?? input;
          output = used.output ?? output;
          break;
        }
        case 'content_block_start': {
          const block = obj(data.content_block);
          if (block?.type === 'tool_use' && index !== null) {
            const i = toolIndex.size;
            toolIndex.set(index, i);
            yield { type: 'tool_call', index: i, id: text(block.id) || `call_${i}`, name: text(block.name) ?? '' };
          }
          break;
        }
        case 'content_block_delta': {
          const piece = text(delta?.text);
          const thinking = text(delta?.thinking);
          const json = text(delta?.partial_json);
          if (delta?.type === 'text_delta' && piece) yield { type: 'delta', text: piece };
          if (delta?.type === 'thinking_delta' && thinking) yield { type: 'reasoning', text: thinking };
          if (delta?.type === 'input_json_delta' && json && index !== null && toolIndex.has(index)) {
            yield { type: 'tool_call', index: toolIndex.get(index)!, arguments: json };
          }
          break;
        }
        case 'message_delta': {
          if (delta?.stop_reason) reason = finish(delta.stop_reason);
          const used = usageBlock(data.usage);
          output = used.output ?? output;
          input = used.input ?? input;
          break;
        }
        case 'error':
          throw new ProviderCallError('server_error', `The provider reported a stream error: ${(text(obj(data.error)?.message) ?? 'unknown').slice(0, 200)}`);
        default:
          break; // ping, content_block_stop, message_stop
      }
      if (data.type === 'message_stop') break;
    }
    yield { type: 'done', finishReason: reason, usage: usage(input, output), model };
  },
};
