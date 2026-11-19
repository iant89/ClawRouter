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

import { AppError } from '@clawrouter/core';
import type { ChatResponse, FinishReason, Usage } from '@clawrouter/providers';
import type { ChatFormatter, ToolCallPiece } from './formats.ts';
import { invalid, parseChatRequest, type ParsedChatRequest } from './openai.ts';

/**
 * The OpenAI Responses API (POST /v1/responses), translated to the chat pipeline.
 * ClawRouter stores no conversation (spec §22), so it is stateless: clients send
 * the whole conversation in `input` (as they do with `store: false`);
 * `previous_response_id` and `item_reference` are refused.
 */

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Request fields echoed in the response object, as OpenAI does. */
export interface ResponsesEcho {
  instructions: string | null;
  maxOutputTokens: number | null;
  temperature: number | null;
  topP: number | null;
  tools: unknown[];
  toolChoice: unknown;
  parallelToolCalls: boolean;
  metadata: Record<string, string>;
}

/** A content part of a Responses message, as a Chat Completions part. */
function chatPart(part: unknown, param: string): Record<string, unknown> {
  if (!isObject(part)) throw invalid('Content parts must be objects.', param);
  switch (part.type) {
    case 'input_text':
    case 'output_text':
      if (typeof part.text !== 'string') throw invalid("A text part needs 'text'.", `${param}.text`);
      return { type: 'text', text: part.text };
    case 'refusal':
      return { type: 'text', text: typeof part.refusal === 'string' ? part.refusal : '' };
    case 'input_image':
      if (typeof part.file_id === 'string') throw invalid("'file_id' refers to a file stored at one provider; send 'image_url' (a URL or a data URL).", `${param}.file_id`);
      return { type: 'image_url', image_url: { url: part.image_url, ...(part.detail !== undefined ? { detail: part.detail } : {}) } };
    case 'input_file':
      if (typeof part.file_id === 'string' || typeof part.file_url === 'string') throw invalid("Send the file inline as 'file_data' (a data URL); 'file_id' and 'file_url' are not supported.", param);
      return { type: 'file', file: { file_data: part.file_data, ...(typeof part.filename === 'string' ? { filename: part.filename } : {}) } };
    case 'input_audio':
      return { type: 'input_audio', input_audio: part.input_audio };
    default:
      throw invalid(`Unknown content part type '${String(part.type)}'.`, param);
  }
}

const TOOL_OUTPUT_TEXT = (output: unknown, param: string): string => {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output.map((p, i) => {
      if (isObject(p) && (p.type === 'input_text' || p.type === 'output_text') && typeof p.text === 'string') return p.text;
      throw invalid('A function call output can only hold text.', `${param}[${i}]`);
    }).join('');
  }
  throw invalid("'output' must be text.", param);
};

/**
 * Parses a Responses request into the chat pipeline's request, plus the fields to
 * echo. Errors in the conversation name the `input[...]` item they came from.
 */
export function parseResponsesRequest(body: unknown): { req: ParsedChatRequest; echo: ResponsesEcho } {
  if (!isObject(body)) throw invalid('The request body must be a JSON object.');
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
    throw invalid("ClawRouter does not store responses: send the whole conversation in 'input' instead of 'previous_response_id'.", 'previous_response_id');
  }
  if (body.conversation !== undefined && body.conversation !== null) throw invalid("ClawRouter does not store conversations: send the whole conversation in 'input'.", 'conversation');
  if (body.background === true) throw invalid("Background responses are not supported.", 'background');
  const text = body.text;
  if (isObject(text) && isObject(text.format) && text.format.type !== 'text') throw invalid(`'text.format' type '${String(text.format.type)}' is not supported yet.`, 'text.format');
  if (body.instructions !== undefined && body.instructions !== null && typeof body.instructions !== 'string') throw invalid("'instructions' must be text.", 'instructions');

  // The conversation, as Chat Completions messages; `source` maps each message back to its input item.
  const messages: Record<string, unknown>[] = [];
  const source: (string | null)[] = [];
  if (typeof body.instructions === 'string' && body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
    source.push('instructions');
  }
  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    source.push('input');
  } else if (Array.isArray(input) && input.length) {
    input.forEach((item, i) => {
      const param = `input[${i}]`;
      if (!isObject(item)) throw invalid('Each input item must be an object.', param);
      const type = item.type ?? (item.role !== undefined ? 'message' : undefined);
      if (type === 'message') {
        const content = typeof item.content === 'string' ? item.content
          : Array.isArray(item.content) ? item.content.map((p, j) => chatPart(p, `${param}.content[${j}]`))
            : (() => { throw invalid("A message needs 'content'.", `${param}.content`); })();
        messages.push({ role: item.role, content });
        source.push(param);
        return;
      }
      if (type === 'function_call') {
        if (typeof item.call_id !== 'string' || !item.call_id) throw invalid("A function call needs 'call_id'.", `${param}.call_id`);
        const call = { id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } };
        // Calls that follow an assistant message (or each other) belong to that assistant turn.
        const last = messages.at(-1);
        if (last?.role === 'assistant') last.tool_calls = [...((last.tool_calls as unknown[] | undefined) ?? []), call];
        else {
          messages.push({ role: 'assistant', content: null, tool_calls: [call] });
          source.push(param);
        }
        return;
      }
      if (type === 'function_call_output') {
        messages.push({ role: 'tool', tool_call_id: item.call_id, content: TOOL_OUTPUT_TEXT(item.output, `${param}.output`) });
        source.push(param);
        return;
      }
      // Reasoning items come back from earlier responses; the model they came from keeps nothing to resume, so they are skipped.
      if (type === 'reasoning') return;
      if (type === 'item_reference') throw invalid("ClawRouter does not store items: send the item itself instead of a reference.", param);
      throw invalid(`Input items of type '${String(type)}' are not supported.`, `${param}.type`);
    });
  } else {
    throw invalid("'input' must be text or a non-empty list of items.", 'input');
  }

  // Tools: only function tools; OpenAI's hosted tools need OpenAI's servers.
  let tools: unknown[] | undefined;
  if (body.tools !== undefined && body.tools !== null) {
    if (!Array.isArray(body.tools)) throw invalid("'tools' must be a list.", 'tools');
    tools = body.tools.map((t, i) => {
      if (!isObject(t)) throw invalid('Each tool must be an object.', `tools[${i}]`);
      if (t.type !== 'function') throw invalid(`Hosted tool '${String(t.type)}' is not available through ClawRouter: only function tools.`, `tools[${i}].type`);
      return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters, ...(typeof t.strict === 'boolean' ? { strict: t.strict } : {}) } };
    });
    if (!tools.length) tools = undefined;
  }
  let toolChoice: unknown = body.tool_choice;
  if (isObject(toolChoice)) {
    if (toolChoice.type !== 'function') throw invalid(`'tool_choice' type '${String(toolChoice.type)}' is not supported: use auto, none, required or a function.`, 'tool_choice');
    toolChoice = { type: 'function', function: { name: toolChoice.name } };
  }

  let req: ParsedChatRequest;
  try {
    req = parseChatRequest({
      model: body.model,
      messages,
      ...(tools ? { tools } : {}),
      ...(toolChoice !== undefined && toolChoice !== null ? { tool_choice: toolChoice } : {}),
      ...(body.parallel_tool_calls !== undefined ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
      ...(body.max_output_tokens !== undefined ? { max_completion_tokens: body.max_output_tokens } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
      ...(body.stream !== undefined ? { stream: body.stream } : {}),
    });
  } catch (error) {
    throw renamed(error, source);
  }
  const metadata = isObject(body.metadata) ? Object.fromEntries(Object.entries(body.metadata).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {};
  return {
    req,
    echo: {
      instructions: typeof body.instructions === 'string' ? body.instructions : null,
      maxOutputTokens: req.maxTokens ?? null,
      temperature: req.temperature ?? null,
      topP: req.topP ?? null,
      tools: Array.isArray(body.tools) ? body.tools : [],
      toolChoice: body.tool_choice ?? 'auto',
      parallelToolCalls: req.parallelToolCalls ?? true,
      metadata,
    },
  };
}

/** Chat Completions parameter names in an error, renamed to what the client sent. */
export function renamed(error: unknown, source: (string | null)[] = []): unknown {
  if (!(error instanceof AppError) || error.code !== 'VALIDATION_ERROR') return error;
  const details = error.details as { param?: string | null; issues?: { path: string; message: string }[] } | undefined;
  const map = (p: string | null | undefined): string | null => {
    if (!p) return p ?? null;
    const m = /^messages\[(\d+)\](.*)$/.exec(p);
    if (m) {
      const base = source[Number(m[1])] ?? 'input';
      const rest = m[2]!.replace(/^\.tool_call_id/, '.call_id').replace(/^\.tool_calls\[\d+\]\.function\.(\w+)/, '.$1').replace(/^\.content\[(\d+)\]\.image_url/, '.content[$1]');
      return base === 'instructions' ? 'instructions' : `${base}${rest}`;
    }
    if (p === 'messages') return 'input';
    if (p === 'max_completion_tokens' || p === 'max_tokens') return 'max_output_tokens';
    return p.replace(/^tools\[(\d+)\]\.function\./, 'tools[$1].');
  };
  const param = map(details?.param);
  return invalid(error.publicMessage.replace(/'max_completion_tokens'/g, "'max_output_tokens'").replace(/'messages'/g, "'input'"), param);
}

/** Usage in the Responses format. */
function usageOf(u: Usage): Record<string, unknown> | null {
  if (u.source !== 'provider' || u.inputTokens === null) return null;
  const output = u.outputTokens ?? 0;
  return {
    input_tokens: u.inputTokens, input_tokens_details: { cached_tokens: 0 },
    output_tokens: output, output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: u.totalTokens ?? u.inputTokens + output,
  };
}

const outputText = (text: string) => ({ type: 'output_text', text, annotations: [], logprobs: [] });
/** A reasoning output item, as OpenAI's open-weight models report raw reasoning (`reasoning_text`, no summary). */
const reasoningItem = (id: string, text: string) => ({ type: 'reasoning', id, status: 'completed', summary: [], content: [{ type: 'reasoning_text', text }] });

/**
 * POST /v1/responses: the response object and its streamed events
 * (response.created, output items, text and argument deltas, response.completed).
 */
export function responsesFormat(o: { id: string; createdAt: number; echo: ResponsesEcho }): ChatFormatter {
  const suffix = o.id.replace(/^resp_/, '');
  let model = '';
  let seq = 0;
  const output: Record<string, unknown>[] = [];

  const response = (status: string, extra: Record<string, unknown> = {}) => ({
    id: o.id, object: 'response', created_at: o.createdAt, status, model,
    output, error: null, incomplete_details: null,
    instructions: o.echo.instructions, max_output_tokens: o.echo.maxOutputTokens,
    temperature: o.echo.temperature, top_p: o.echo.topP,
    tools: o.echo.tools, tool_choice: o.echo.toolChoice, parallel_tool_calls: o.echo.parallelToolCalls,
    previous_response_id: null, store: false, truncation: 'disabled',
    text: { format: { type: 'text' } }, reasoning: { effort: null, summary: null },
    metadata: o.echo.metadata, user: null, usage: null,
    ...extra,
  });
  const ending = (reason: FinishReason, usage: Usage) => {
    const status = reason === 'length' ? 'incomplete' : 'completed';
    return response(status, {
      usage: usageOf(usage),
      ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    });
  };
  const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`;

  // Streaming state: the open message (text) and function calls by stream index.
  let message: { id: string; index: number; text: string } | null = null;
  const calls = new Map<number, { item: Record<string, unknown>; index: number; open: boolean }>();
  let items = 0;
  const itemId = (kind: string) => `${kind}_${suffix}_${items}`;

  // The open reasoning item: the model's reasoning, as `reasoning_text` (how OpenAI's open-weight models report it).
  let thinking: { id: string; index: number; text: string } | null = null;
  const closeReasoning = (): string[] => {
    if (!thinking) return [];
    const t = thinking;
    thinking = null;
    const item = reasoningItem(t.id, t.text);
    output[t.index] = item;
    return [
      event('response.reasoning_text.done', { item_id: t.id, output_index: t.index, content_index: 0, text: t.text }),
      event('response.output_item.done', { output_index: t.index, item }),
    ];
  };

  const closeMessage = (): string[] => {
    if (!message) return [];
    const m = message;
    message = null;
    const item = { type: 'message', id: m.id, status: 'completed', role: 'assistant', content: [outputText(m.text)] };
    output[m.index] = item;
    return [
      event('response.output_text.done', { item_id: m.id, output_index: m.index, content_index: 0, text: m.text, logprobs: [] }),
      event('response.content_part.done', { item_id: m.id, output_index: m.index, content_index: 0, part: outputText(m.text) }),
      event('response.output_item.done', { output_index: m.index, item }),
    ];
  };
  const closeCalls = (): string[] => {
    const out: string[] = [];
    for (const c of calls.values()) {
      if (!c.open) continue;
      c.open = false;
      c.item.status = 'completed';
      out.push(
        event('response.function_call_arguments.done', { item_id: c.item.id, output_index: c.index, arguments: c.item.arguments }),
        event('response.output_item.done', { output_index: c.index, item: c.item }),
      );
    }
    return out;
  };

  return {
    complete(r: ChatResponse, m: string) {
      model = m;
      if (r.reasoning) output.push(reasoningItem(`rs_${suffix}_0`, r.reasoning));
      items = output.length;
      if (r.content) output.push({ type: 'message', id: itemId('msg'), status: 'completed', role: 'assistant', content: [outputText(r.content)] });
      for (const [i, c] of (r.toolCalls ?? []).entries()) {
        items = output.length + i;
        output.push({ type: 'function_call', id: `fc_${suffix}_${output.length}`, call_id: c.id, name: c.name, arguments: c.arguments, status: 'completed' });
      }
      return ending(r.finishReason, r.usage);
    },
    start(m) {
      model = m;
      return [event('response.created', { response: response('in_progress') }), event('response.in_progress', { response: response('in_progress') })];
    },
    text(delta) {
      const out: string[] = closeReasoning();
      if (!message) {
        const index = output.length;
        items = index;
        message = { id: itemId('msg'), index, text: '' };
        output.push({ type: 'message', id: message.id, status: 'in_progress', role: 'assistant', content: [] });
        out.push(
          event('response.output_item.added', { output_index: index, item: { type: 'message', id: message.id, status: 'in_progress', role: 'assistant', content: [] } }),
          event('response.content_part.added', { item_id: message.id, output_index: index, content_index: 0, part: outputText('') }),
        );
      }
      message.text += delta;
      out.push(event('response.output_text.delta', { item_id: message.id, output_index: message.index, content_index: 0, delta, logprobs: [] }));
      return out;
    },
    reasoning(delta) {
      const out = closeMessage();
      if (!thinking) {
        const index = output.length;
        items = index;
        thinking = { id: itemId('rs'), index, text: '' };
        output.push({ type: 'reasoning', id: thinking.id, status: 'in_progress', summary: [], content: [] });
        out.push(event('response.output_item.added', { output_index: index, item: { type: 'reasoning', id: thinking.id, status: 'in_progress', summary: [], content: [] } }));
      }
      thinking.text += delta;
      out.push(event('response.reasoning_text.delta', { item_id: thinking.id, output_index: thinking.index, content_index: 0, delta }));
      return out;
    },
    toolCall(piece: ToolCallPiece) {
      const out = [...closeReasoning(), ...closeMessage()];
      let call = calls.get(piece.index);
      if (!call) {
        const index = output.length;
        items = index;
        const item = { type: 'function_call', id: itemId('fc'), call_id: piece.id ?? `call_${suffix}_${index}`, name: piece.name ?? '', arguments: '', status: 'in_progress' };
        call = { item, index, open: true };
        calls.set(piece.index, call);
        output.push(item);
        out.push(event('response.output_item.added', { output_index: index, item: { ...item } }));
      } else if (piece.name) {
        call.item.name = `${call.item.name as string}${piece.name}`;
      }
      if (piece.arguments) {
        call.item.arguments = `${call.item.arguments as string}${piece.arguments}`;
        out.push(event('response.function_call_arguments.delta', { item_id: call.item.id, output_index: call.index, delta: piece.arguments }));
      }
      return out;
    },
    finish(reason, usage) {
      const final = ending(reason, usage);
      return [...closeReasoning(), ...closeMessage(), ...closeCalls(), event(final.status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response: ending(reason, usage) })];
    },
    end() {
      return [...closeReasoning(), ...closeMessage(), ...closeCalls(), event('response.completed', { response: ending('stop', { inputTokens: null, outputTokens: null, totalTokens: null, source: 'none' }) })];
    },
    error() {
      return [event('response.failed', { response: response('failed', { error: { code: 'server_error', message: 'The model provider failed while streaming the response.' } }) })];
    },
  };
}
