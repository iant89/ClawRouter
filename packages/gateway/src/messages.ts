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
 * The Anthropic Messages API (POST /v1/messages), translated to the chat pipeline,
 * so clients built for Claude (the Anthropic SDKs, Claude Code) can use ClawRouter
 * and any provider behind it. Like /v1/responses it builds a Chat Completions body
 * and validates it with `parseChatRequest`; errors are renamed back to Messages
 * fields. Features that need Anthropic's own servers (server tools, MCP servers,
 * containers, structured outputs) are refused; settings that only tune Claude
 * (thinking, effort, prompt caching, top_k, metadata) are accepted and ignored,
 * because a client built for Claude sends them on every request.
 */

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Rough local token count (about four characters per token): Claude clients read input_tokens to manage their context. */
const tokens = (chars: number) => Math.max(1, Math.ceil(chars / 4));

export interface ParsedMessagesRequest {
  req: ParsedChatRequest;
  /** Estimated input tokens (messages, system and tools), for count_tokens and when the provider reports none. */
  estimatedInputTokens: number;
}

const IMAGE_SOURCE = "An image needs a 'source' of type base64 (media_type and data) or url.";

/** An image block as a Chat Completions image part. */
function imagePart(block: Record<string, unknown>, param: string): Record<string, unknown> {
  const src = isObject(block.source) ? block.source : null;
  if (src?.type === 'base64' && typeof src.media_type === 'string' && typeof src.data === 'string') {
    return { type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } };
  }
  if (src?.type === 'url' && typeof src.url === 'string') return { type: 'image_url', image_url: { url: src.url } };
  if (src?.type === 'file') throw invalid("Files stored with Anthropic's Files API are not available through ClawRouter: send the image inline (base64) or as a URL.", `${param}.source`);
  throw invalid(IMAGE_SOURCE, `${param}.source`);
}

/** A document block: a PDF as a file part, plain text as text. */
function documentParts(block: Record<string, unknown>, param: string): Record<string, unknown>[] {
  const src = isObject(block.source) ? block.source : null;
  const title = typeof block.title === 'string' && block.title.trim() ? block.title.trim() : null;
  if (src?.type === 'base64' && typeof src.data === 'string') {
    if (src.media_type !== 'application/pdf') throw invalid('Base64 documents must be PDFs (media_type application/pdf).', `${param}.source.media_type`);
    return [{ type: 'file', file: { file_data: `data:application/pdf;base64,${src.data}`, ...(title ? { filename: title } : {}) } }];
  }
  if (src?.type === 'text' && typeof src.data === 'string') return [{ type: 'text', text: title ? `${title}\n\n${src.data}` : src.data }];
  if (src?.type === 'content' && Array.isArray(src.content)) {
    return src.content.filter((b): b is Record<string, unknown> => isObject(b) && b.type === 'text' && typeof b.text === 'string').map((b) => ({ type: 'text', text: b.text }));
  }
  if (src?.type === 'url' || src?.type === 'file') throw invalid('Send documents inline (base64 PDF or text): URL and Files API documents are not available through ClawRouter.', `${param}.source`);
  throw invalid("A document needs a 'source' of type base64 (a PDF), text or content.", `${param}.source`);
}

/** A tool result's content: text, plus any images (sent after the results, in a user message). */
function toolResultContent(block: Record<string, unknown>, param: string): { text: string; images: Record<string, unknown>[] } {
  const raw = block.content;
  const images: Record<string, unknown>[] = [];
  let text: string;
  if (raw === undefined || raw === null) text = '';
  else if (typeof raw === 'string') text = raw;
  else if (Array.isArray(raw)) {
    text = raw.map((b, i) => {
      if (!isObject(b)) throw invalid('Tool result content blocks must be objects.', `${param}.content[${i}]`);
      if (b.type === 'text') return typeof b.text === 'string' ? b.text : '';
      if (b.type === 'image') {
        images.push(imagePart(b, `${param}.content[${i}]`));
        return '';
      }
      if (b.type === 'document') return documentParts(b, `${param}.content[${i}]`).map((p) => (p.type === 'text' ? String(p.text) : '')).join('');
      throw invalid(`Tool result content of type '${String(b.type)}' is not supported.`, `${param}.content[${i}].type`);
    }).join('\n');
  } else throw invalid("A tool result's 'content' must be text or a list of blocks.", `${param}.content`);
  return { text: block.is_error === true ? `Error: ${text}` : text, images };
}

/** Text of `system`: a string or a list of text blocks. */
function systemText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((b, i) => {
      if (!isObject(b) || b.type !== 'text' || typeof b.text !== 'string') throw invalid("'system' must be text or a list of text blocks.", `system[${i}]`);
      return b.text;
    }).join('\n\n');
  }
  throw invalid("'system' must be text or a list of text blocks.", 'system');
}

/** Fields that need Anthropic's own servers: refused, so a client is not misled. */
const REFUSED: Record<string, string> = {
  mcp_servers: "Anthropic's MCP connector runs on Anthropic's servers and is not available through ClawRouter.",
  container: "Containers (code execution, Agent Skills) run on Anthropic's servers and are not available through ClawRouter.",
};

/**
 * Parses a Messages request. `count_tokens` takes the same body without
 * `max_tokens`. Errors name the Messages field the client sent.
 */
export function parseMessagesRequest(body: unknown, options: { countOnly?: boolean } = {}): ParsedMessagesRequest {
  if (!isObject(body)) throw invalid('The request body must be a JSON object.');
  for (const [field, message] of Object.entries(REFUSED)) {
    if (body[field] !== undefined && body[field] !== null && !(Array.isArray(body[field]) && !(body[field] as unknown[]).length)) throw invalid(message, field);
  }
  const outputConfig = isObject(body.output_config) ? body.output_config : null;
  if (outputConfig?.format !== undefined && outputConfig.format !== null) throw invalid("Structured outputs ('output_config.format') are not supported through ClawRouter yet.", 'output_config.format');
  if (!options.countOnly && (body.max_tokens === undefined || body.max_tokens === null)) throw invalid("'max_tokens' is required.", 'max_tokens');
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw invalid("'messages' must be a non-empty list.", 'messages');

  // The conversation as Chat Completions messages; `source` maps each back to the Messages field it came from.
  const messages: Record<string, unknown>[] = [];
  const source: string[] = [];
  let chars = 0;
  const push = (m: Record<string, unknown>, from: string) => {
    messages.push(m);
    source.push(from);
  };
  if (body.system !== undefined && body.system !== null) {
    const text = systemText(body.system);
    chars += text.length;
    if (text) push({ role: 'system', content: text }, 'system');
  }

  body.messages.forEach((raw, i) => {
    const param = `messages[${i}]`;
    if (!isObject(raw)) throw invalid('Each message must be an object.', param);
    const role = raw.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') throw invalid("Role must be 'user' or 'assistant'.", `${param}.role`);
    if (typeof raw.content === 'string') {
      chars += raw.content.length;
      push({ role, content: raw.content }, param);
      return;
    }
    if (!Array.isArray(raw.content)) throw invalid("'content' must be text or a list of content blocks.", `${param}.content`);
    const blocks = raw.content;

    if (role === 'assistant') {
      let text = '';
      const calls: Record<string, unknown>[] = [];
      blocks.forEach((b, j) => {
        const p = `${param}.content[${j}]`;
        if (!isObject(b)) throw invalid('Content blocks must be objects.', p);
        if (b.type === 'text') text += typeof b.text === 'string' ? b.text : '';
        else if (b.type === 'tool_use') {
          if (typeof b.id !== 'string' || !b.id) throw invalid("A tool_use block needs an 'id'.", `${p}.id`);
          if (typeof b.name !== 'string' || !b.name) throw invalid("A tool_use block needs a 'name'.", `${p}.name`);
          const args = JSON.stringify(b.input ?? {});
          chars += b.name.length + args.length;
          calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: args } });
        } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
          // Earlier reasoning, signed by the model that wrote it: no other model can use it.
        } else throw invalid(`Assistant content of type '${String(b.type)}' is not supported through ClawRouter.`, `${p}.type`);
      });
      chars += text.length;
      push({ role: 'assistant', content: calls.length && !text ? null : text, ...(calls.length ? { tool_calls: calls } : {}) }, param);
      return;
    }

    // User (or system) content: tool results become tool messages, in order, before the rest.
    const parts: Record<string, unknown>[] = [];
    const toolImages: Record<string, unknown>[] = [];
    blocks.forEach((b, j) => {
      const p = `${param}.content[${j}]`;
      if (!isObject(b)) throw invalid('Content blocks must be objects.', p);
      switch (b.type) {
        case 'text':
          if (typeof b.text !== 'string') throw invalid("A text block needs 'text'.", `${p}.text`);
          chars += b.text.length;
          parts.push({ type: 'text', text: b.text });
          return;
        case 'image':
          if (role !== 'user') throw invalid('Only user messages can carry images.', p);
          parts.push(imagePart(b, p));
          return;
        case 'document':
          if (role !== 'user') throw invalid('Only user messages can carry documents.', p);
          for (const part of documentParts(b, p)) {
            if (part.type === 'text') chars += String(part.text).length;
            parts.push(part);
          }
          return;
        case 'tool_result': {
          if (role !== 'user') throw invalid('Tool results belong in a user message.', p);
          if (typeof b.tool_use_id !== 'string' || !b.tool_use_id) throw invalid("A tool_result block needs 'tool_use_id'.", `${p}.tool_use_id`);
          const { text, images } = toolResultContent(b, p);
          chars += text.length;
          toolImages.push(...images);
          push({ role: 'tool', tool_call_id: b.tool_use_id, content: text }, p);
          return;
        }
        default:
          throw invalid(`Content blocks of type '${String(b.type)}' are not supported through ClawRouter.`, `${p}.type`);
      }
    });
    // Images a tool returned (a screenshot, a file read as an image) follow the results as user content.
    const content = [...(toolImages.length ? [{ type: 'text', text: 'Images from the tool results above:' }, ...toolImages] : []), ...parts];
    if (!content.length) return;
    const textOnly = content.every((c) => c.type === 'text');
    push({ role, content: textOnly ? content.map((c) => String(c.text)).join('\n') : content }, param);
  });

  // Tools: client tools only; Anthropic's server tools need Anthropic's servers.
  let tools: Record<string, unknown>[] | undefined;
  if (body.tools !== undefined && body.tools !== null) {
    if (!Array.isArray(body.tools)) throw invalid("'tools' must be a list.", 'tools');
    tools = body.tools.map((t, i) => {
      if (!isObject(t)) throw invalid('Each tool must be an object.', `tools[${i}]`);
      if (t.type !== undefined && t.type !== null && t.type !== 'custom') {
        throw invalid(`The server tool '${String(t.type)}' runs on Anthropic's servers and is not available through ClawRouter: only tools with an 'input_schema'.`, `tools[${i}].type`);
      }
      chars += JSON.stringify(t).length;
      return {
        type: 'function',
        function: {
          name: t.name, description: t.description, parameters: t.input_schema ?? { type: 'object', properties: {} },
          ...(typeof t.strict === 'boolean' ? { strict: t.strict } : {}),
        },
      };
    });
    if (!tools.length) tools = undefined;
  }
  let toolChoice: unknown;
  let parallel: boolean | undefined;
  if (isObject(body.tool_choice)) {
    const c = body.tool_choice;
    if (c.disable_parallel_tool_use === true) parallel = false;
    if (c.type === 'auto') toolChoice = tools ? 'auto' : undefined;
    else if (c.type === 'none') toolChoice = tools ? 'none' : undefined;
    else if (c.type === 'any') toolChoice = 'required';
    else if (c.type === 'tool') toolChoice = { type: 'function', function: { name: c.name } };
    else throw invalid("'tool_choice' type must be auto, any, tool or none.", 'tool_choice.type');
  } else if (body.tool_choice !== undefined && body.tool_choice !== null) throw invalid("'tool_choice' must be an object such as { \"type\": \"auto\" }.", 'tool_choice');

  let req: ParsedChatRequest;
  try {
    req = parseChatRequest({
      model: body.model,
      messages,
      ...(tools ? { tools } : {}),
      ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
      ...(parallel !== undefined && tools ? { parallel_tool_calls: parallel } : {}),
      ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
      ...(body.stop_sequences !== undefined ? { stop: body.stop_sequences } : {}),
      ...(body.stream !== undefined && !options.countOnly ? { stream: body.stream } : {}),
    });
  } catch (error) {
    throw messagesRenamed(error, source);
  }
  return { req, estimatedInputTokens: tokens(chars) };
}

/** Chat Completions parameter names in an error, renamed to what the client sent. */
export function messagesRenamed(error: unknown, source: string[] = []): unknown {
  if (!(error instanceof AppError) || error.code !== 'VALIDATION_ERROR') return error;
  const details = error.details as { param?: string | null } | undefined;
  const map = (p: string | null | undefined): string | null => {
    if (!p) return p ?? null;
    const m = /^messages\[(\d+)\](.*)$/.exec(p);
    if (m) {
      const base = source[Number(m[1])] ?? 'messages';
      const rest = m[2]!.replace(/^\.tool_call_id/, '.tool_use_id').replace(/^\.tool_calls\[\d+\]\.function\.(\w+)/, '.$1').replace(/^\.content\[\d+\]\.image_url.*/, '');
      return `${base}${rest}`;
    }
    if (p === 'max_completion_tokens') return 'max_tokens';
    if (p === 'stop') return 'stop_sequences';
    if (p === 'tool_choice' || p === 'parallel_tool_calls') return 'tool_choice';
    return p.replace(/^tools\[(\d+)\]\.function\.parameters/, 'tools[$1].input_schema').replace(/^tools\[(\d+)\]\.function\./, 'tools[$1].');
  };
  const message = error.publicMessage
    .replace(/'max_completion_tokens'/g, "'max_tokens'").replace(/'stop'/g, "'stop_sequences'")
    .replace(/'tool_call_id'/g, "'tool_use_id'").replace(/This tool message answers no earlier tool call\./, 'This tool_result answers no tool_use in the previous assistant message.');
  return invalid(message, map(details?.param));
}

/** Messages API stop reasons. */
export function stopReason(r: FinishReason): string {
  switch (r) {
    case 'length': return 'max_tokens';
    case 'tool_use': return 'tool_use';
    case 'content_filter': return 'refusal';
    default: return 'end_turn';
  }
}

/** A tool call's arguments as the `input` object Claude clients expect. */
function inputOf(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args || '{}') as unknown;
    return isObject(parsed) ? parsed : { value: parsed };
  } catch {
    return {};
  }
}

/**
 * POST /v1/messages: the message object and its streamed events (message_start,
 * content blocks with text_delta / input_json_delta, message_delta, message_stop).
 * Usage the provider did not report is estimated, because Claude clients use
 * input_tokens to decide when to compact their context.
 */
export function messagesFormat(o: { id: string; estimatedInputTokens: number }): ChatFormatter {
  let model = '';
  let outputChars = 0;
  const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const usageOf = (u: Usage) => ({
    input_tokens: u.inputTokens ?? o.estimatedInputTokens,
    output_tokens: u.outputTokens ?? tokens(outputChars),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });

  // Streaming: one open content block at a time, numbered in order.
  let next = 0;
  let open: { kind: 'text'; index: number } | { kind: 'tool'; index: number; stream: number } | null = null;
  const close = (): string[] => {
    if (!open) return [];
    const index = open.index;
    open = null;
    return [event('content_block_stop', { index })];
  };
  const ending = (reason: FinishReason, usage: Usage) => [
    ...close(),
    event('message_delta', { delta: { stop_reason: stopReason(reason), stop_sequence: null }, usage: usageOf(usage) }),
    event('message_stop', {}),
  ];

  return {
    complete(r: ChatResponse, m: string) {
      model = m;
      const content: Record<string, unknown>[] = [];
      if (r.content) content.push({ type: 'text', text: r.content });
      outputChars = r.content.length;
      for (const c of r.toolCalls ?? []) {
        outputChars += c.name.length + c.arguments.length;
        content.push({ type: 'tool_use', id: c.id, name: c.name, input: inputOf(c.arguments) });
      }
      return {
        id: o.id, type: 'message', role: 'assistant', model, content,
        stop_reason: stopReason(r.finishReason), stop_sequence: null, usage: usageOf(r.usage),
      };
    },
    start(m) {
      model = m;
      return [event('message_start', {
        message: {
          id: o.id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: o.estimatedInputTokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      })];
    },
    text(delta) {
      const out: string[] = [];
      if (open?.kind !== 'text') {
        out.push(...close());
        open = { kind: 'text', index: next++ };
        out.push(event('content_block_start', { index: open.index, content_block: { type: 'text', text: '' } }));
      }
      outputChars += delta.length;
      out.push(event('content_block_delta', { index: open.index, delta: { type: 'text_delta', text: delta } }));
      return out;
    },
    toolCall(piece: ToolCallPiece) {
      const out: string[] = [];
      if (open?.kind !== 'tool' || open.stream !== piece.index) {
        out.push(...close());
        const tool = { kind: 'tool' as const, index: next++, stream: piece.index };
        open = tool;
        outputChars += piece.name?.length ?? 0;
        out.push(event('content_block_start', {
          index: tool.index,
          content_block: { type: 'tool_use', id: piece.id ?? `toolu_${o.id.replace(/^msg_/, '')}_${tool.index}`, name: piece.name ?? '', input: {} },
        }));
      }
      if (piece.arguments) {
        outputChars += piece.arguments.length;
        out.push(event('content_block_delta', { index: open.index, delta: { type: 'input_json_delta', partial_json: piece.arguments } }));
      }
      return out;
    },
    finish: (reason, usage) => ending(reason, usage),
    end: () => ending('stop', { inputTokens: null, outputTokens: null, totalTokens: null, source: 'none' }),
    error: () => [event('error', { error: { type: 'api_error', message: 'The model provider failed while streaming the response.' } })],
  };
}
