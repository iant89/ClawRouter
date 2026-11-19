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
import type { ChatMessage, FinishReason, MessagePart, ToolCall, ToolChoice, ToolDefinition, Usage } from '@clawrouter/providers';

/**
 * The external API speaks the OpenAI wire format (spec §7): requests are parsed
 * and validated here and responses built here. Provider formats never reach clients.
 */

/** A client error in the request, pointing at the offending parameter (OpenAI `param`). */
export function invalid(message: string, param: string | null = null): AppError {
  return new AppError('VALIDATION_ERROR', message, { details: { param, issues: param ? [{ path: param, message }] : [] } });
}

export interface ParsedChatRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
  /** Tools are defined, or the conversation holds tool calls or results: the model needs TOOL_USE. */
  usesTools: boolean;
  stream: boolean;
  includeUsage: boolean;
}

export interface ParsedEmbeddingRequest {
  model: string;
  input: string[];
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function num(body: Record<string, unknown>, key: string, min: number, max: number, integer = false): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
    throw invalid(`'${key}' must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}.`, key);
  }
  return v;
}

function model(body: Record<string, unknown>): string {
  if (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 300) throw invalid("'model' is required: an alias, a model reference or a model id.", 'model');
  return body.model.trim();
}

/** Largest inline media item (decoded), and most media items in one request. */
export const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
export const MAX_MEDIA_PARTS = 50;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Base64 data checked for shape and size (decoded); returned without whitespace. */
function base64(value: unknown, what: string, param: string): string {
  if (typeof value !== 'string' || !value) throw invalid(`${what} must be base64 data.`, param);
  const data = value.replace(/\s+/g, '');
  if (!BASE64.test(data) || data.length % 4 !== 0) throw invalid(`${what} is not valid base64.`, param);
  if ((data.length / 4) * 3 > MAX_MEDIA_BYTES) throw invalid(`${what} is larger than ${MAX_MEDIA_BYTES / 1024 / 1024} MB.`, param);
  return data;
}

/** `data:<type>;base64,<data>` split into its type and data. */
function dataUrl(url: string, param: string): { mediaType: string; data: string } {
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,(.*)$/s.exec(url);
  if (!m) throw invalid('A data URL must look like data:<type>;base64,<data>.', param);
  return { mediaType: m[1]!.toLowerCase(), data: base64(m[2], 'The data URL', param) };
}

function mediaPart(part: Record<string, unknown>, param: string): MessagePart {
  if (part.type === 'image_url') {
    const raw = isObject(part.image_url) ? part.image_url : typeof part.image_url === 'string' ? { url: part.image_url } : null;
    if (!raw || typeof raw.url !== 'string') throw invalid("An image part needs 'image_url.url'.", `${param}.image_url`);
    const detail = raw.detail === undefined || raw.detail === null ? undefined : raw.detail;
    if (detail !== undefined && detail !== 'auto' && detail !== 'low' && detail !== 'high') throw invalid("'detail' must be auto, low or high.", `${param}.image_url.detail`);
    if (raw.url.startsWith('data:')) {
      const { mediaType, data } = dataUrl(raw.url, `${param}.image_url.url`);
      if (!IMAGE_TYPES.has(mediaType)) throw invalid('Images must be PNG, JPEG, GIF or WebP.', `${param}.image_url.url`);
      return { type: 'image', source: { kind: 'data', mediaType, data }, ...(detail ? { detail } : {}) };
    }
    let url: URL;
    try {
      url = new URL(raw.url);
    } catch {
      throw invalid('The image URL is not valid.', `${param}.image_url.url`);
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || raw.url.length > 8192) throw invalid('Image URLs must be http(s) URLs, or data URLs.', `${param}.image_url.url`);
    return { type: 'image', source: { kind: 'url', url: raw.url }, ...(detail ? { detail } : {}) };
  }
  if (part.type === 'input_audio') {
    const a = isObject(part.input_audio) ? part.input_audio : null;
    if (!a || (a.format !== 'wav' && a.format !== 'mp3')) throw invalid("An audio part needs 'input_audio' with 'data' and 'format' (wav or mp3).", `${param}.input_audio`);
    return { type: 'audio', format: a.format, data: base64(a.data, 'The audio', `${param}.input_audio.data`) };
  }
  if (part.type === 'file') {
    const f = isObject(part.file) ? part.file : null;
    if (f && typeof f.file_id === 'string') throw invalid("'file_id' refers to a file stored at one provider; send the file inline as 'file_data'.", `${param}.file.file_id`);
    if (!f || typeof f.file_data !== 'string') throw invalid("A file part needs 'file.file_data' (a data URL).", `${param}.file`);
    const { mediaType, data } = dataUrl(f.file_data, `${param}.file.file_data`);
    if (mediaType !== 'application/pdf') throw invalid('Only PDF files are supported.', `${param}.file.file_data`);
    const filename = typeof f.filename === 'string' && f.filename.trim() ? f.filename.trim().slice(0, 255) : null;
    return { type: 'pdf', filename, data };
  }
  throw invalid(`Unknown content part type '${String(part.type)}'.`, param);
}

/**
 * An OpenAI content value: a string, or an array of parts. Text parts are joined
 * into `content`; with media (user messages only) the parts are kept in order.
 */
function content(value: unknown, param: string, mayHaveMedia: boolean): { content: string; parts?: MessagePart[] } {
  if (typeof value === 'string') return { content: value };
  if (value === null || value === undefined) return { content: '' };
  if (!Array.isArray(value)) throw invalid('Message content must be a string or an array of parts.', param);
  const parts = value.map((part, i): MessagePart => {
    if (!isObject(part)) throw invalid('Content parts must be objects.', `${param}[${i}]`);
    if (part.type === 'text') {
      if (typeof part.text !== 'string') throw invalid("A text part needs 'text'.", `${param}[${i}].text`);
      return { type: 'text', text: part.text };
    }
    if (!mayHaveMedia && (part.type === 'image_url' || part.type === 'input_audio' || part.type === 'file')) {
      throw invalid('Only user messages can carry images, audio or files.', `${param}[${i}]`);
    }
    return mediaPart(part, `${param}[${i}]`);
  });
  const text = parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  return parts.some((p) => p.type !== 'text') ? { content: text, parts } : { content: text };
}

export const MAX_TOOLS = 128;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** Largest tool parameter schema, serialized. */
const MAX_SCHEMA_BYTES = 100_000;

/** `tools`: OpenAI function tools. */
function parseTools(value: unknown): ToolDefinition[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TOOLS) throw invalid(`'tools' must be a list of 1 to ${MAX_TOOLS} tools.`, 'tools');
  const seen = new Set<string>();
  return value.map((t, i) => {
    const param = `tools[${i}]`;
    if (!isObject(t) || t.type !== 'function' || !isObject(t.function)) throw invalid("Each tool must be { type: 'function', function: { name, description, parameters } }.", param);
    const f = t.function;
    if (typeof f.name !== 'string' || !TOOL_NAME.test(f.name)) throw invalid('Tool names are 1–64 letters, digits, underscores or dashes.', `${param}.function.name`);
    if (seen.has(f.name)) throw invalid(`Two tools are named '${f.name}'.`, `${param}.function.name`);
    seen.add(f.name);
    if (f.description !== undefined && f.description !== null && (typeof f.description !== 'string' || f.description.length > 8192)) throw invalid('A tool description must be text of up to 8,192 characters.', `${param}.function.description`);
    if (f.parameters !== undefined && f.parameters !== null) {
      if (!isObject(f.parameters)) throw invalid("'parameters' must be a JSON Schema object.", `${param}.function.parameters`);
      if (JSON.stringify(f.parameters).length > MAX_SCHEMA_BYTES) throw invalid('The parameter schema is too large.', `${param}.function.parameters`);
    }
    if (f.strict !== undefined && f.strict !== null && typeof f.strict !== 'boolean') throw invalid("'strict' must be a boolean.", `${param}.function.strict`);
    return {
      name: f.name,
      ...(typeof f.description === 'string' ? { description: f.description } : {}),
      ...(isObject(f.parameters) ? { parameters: f.parameters } : {}),
      ...(typeof f.strict === 'boolean' ? { strict: f.strict } : {}),
    };
  });
}

/** `tool_choice`: auto, none, required, or one named tool (which must be defined). */
function parseToolChoice(value: unknown, tools: ToolDefinition[] | undefined): ToolChoice | undefined {
  if (value === undefined || value === null) return undefined;
  if (!tools) throw invalid("'tool_choice' needs 'tools'.", 'tool_choice');
  if (value === 'auto' || value === 'none' || value === 'required') return value;
  if (isObject(value) && value.type === 'function' && isObject(value.function) && typeof value.function.name === 'string') {
    const name = value.function.name;
    if (!tools.some((t) => t.name === name)) throw invalid(`'tool_choice' names '${name}', which is not in 'tools'.`, 'tool_choice');
    return { name };
  }
  throw invalid("'tool_choice' must be auto, none, required or { type: 'function', function: { name } }.", 'tool_choice');
}

/** An assistant message's `tool_calls`, as a client sends them back in the conversation. */
function parseToolCalls(value: unknown, param: string): ToolCall[] {
  if (!Array.isArray(value) || value.length > MAX_TOOLS) throw invalid(`'tool_calls' must be a list of up to ${MAX_TOOLS} calls.`, param);
  return value.map((c, i) => {
    const p = `${param}[${i}]`;
    if (!isObject(c) || (c.type !== undefined && c.type !== 'function') || !isObject(c.function)) throw invalid("Each tool call must be { id, type: 'function', function: { name, arguments } }.", p);
    // Ids are opaque; ClawRouter's Gemini ids carry the model's thought signature, so they can be long.
    if (typeof c.id !== 'string' || !c.id || c.id.length > 32_768) throw invalid("A tool call needs an 'id'.", `${p}.id`);
    if (typeof c.function.name !== 'string' || !c.function.name) throw invalid("A tool call needs 'function.name'.", `${p}.function.name`);
    if (typeof c.function.arguments !== 'string') throw invalid("'function.arguments' must be the JSON text the model produced.", `${p}.function.arguments`);
    return { id: c.id, name: c.function.name, arguments: c.function.arguments };
  });
}

/** Parses POST /v1/chat/completions. Unsupported features fail clearly instead of being ignored. */
export function parseChatRequest(body: unknown): ParsedChatRequest {
  if (!isObject(body)) throw invalid('The request body must be a JSON object.');
  const m = model(body);
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw invalid("'messages' must be a non-empty array.", 'messages');
  if (body.messages.length > 10_000) throw invalid("'messages' has too many entries.", 'messages');
  for (const key of ['functions', 'function_call'] as const) {
    if (body[key] !== undefined && body[key] !== null) throw invalid(`'${key}' is deprecated: send 'tools' and 'tool_choice' instead.`, key);
  }
  const tools = parseTools(body.tools);
  const toolChoice = parseToolChoice(body.tool_choice, tools);
  if (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== null && typeof body.parallel_tool_calls !== 'boolean') throw invalid("'parallel_tool_calls' must be a boolean.", 'parallel_tool_calls');
  if (body.n !== undefined && body.n !== null && body.n !== 1) throw invalid("Only 'n': 1 is supported.", 'n');
  const format = body.response_format;
  if (isObject(format) && format.type !== 'text') throw invalid(`'response_format' type '${String(format.type)}' is not supported yet.`, 'response_format');

  const callIds = new Set<string>();
  const messages: ChatMessage[] = body.messages.map((raw, i) => {
    const param = `messages[${i}]`;
    if (!isObject(raw)) throw invalid('Each message must be an object.', param);
    const role = raw.role === 'developer' ? 'system' : raw.role;
    if (role === 'function') throw invalid("Role 'function' is deprecated: answer tool calls with role 'tool' and 'tool_call_id'.", `${param}.role`);
    if (role === 'tool') {
      if (typeof raw.tool_call_id !== 'string' || !raw.tool_call_id) throw invalid("A tool message needs 'tool_call_id'.", `${param}.tool_call_id`);
      if (!callIds.has(raw.tool_call_id)) throw invalid('This tool message answers no earlier tool call.', `${param}.tool_call_id`);
      return { role: 'tool', toolCallId: raw.tool_call_id, ...content(raw.content, `${param}.content`, false) };
    }
    if (role !== 'system' && role !== 'user' && role !== 'assistant') throw invalid("Role must be 'system', 'developer', 'user', 'assistant' or 'tool'.", `${param}.role`);
    if (role === 'assistant' && raw.tool_calls !== undefined && raw.tool_calls !== null) {
      const toolCalls = parseToolCalls(raw.tool_calls, `${param}.tool_calls`);
      for (const c of toolCalls) callIds.add(c.id);
      return { role, ...content(raw.content, `${param}.content`, false), ...(toolCalls.length ? { toolCalls } : {}) };
    }
    return { role, ...content(raw.content, `${param}.content`, role === 'user') };
  });
  if (!messages.some((m2) => m2.role === 'user')) throw invalid('At least one user message is required.', 'messages');
  const media = messages.reduce((n, m2) => n + (m2.parts ?? []).filter((p) => p.type !== 'text').length, 0);
  if (media > MAX_MEDIA_PARTS) throw invalid(`At most ${MAX_MEDIA_PARTS} images, audio clips or files per request.`, 'messages');

  let stop: string[] | undefined;
  if (typeof body.stop === 'string') stop = [body.stop];
  else if (Array.isArray(body.stop)) {
    if (body.stop.length > 4 || !body.stop.every((s) => typeof s === 'string')) throw invalid("'stop' must be a string or up to 4 strings.", 'stop');
    stop = body.stop as string[];
  } else if (body.stop !== undefined && body.stop !== null) throw invalid("'stop' must be a string or up to 4 strings.", 'stop');

  if (body.stream !== undefined && body.stream !== null && typeof body.stream !== 'boolean') throw invalid("'stream' must be a boolean.", 'stream');
  const stream = body.stream === true;
  const streamOptions = isObject(body.stream_options) ? body.stream_options : {};

  return {
    model: m,
    messages,
    maxTokens: num(body, 'max_completion_tokens', 1, 1_000_000, true) ?? num(body, 'max_tokens', 1, 1_000_000, true),
    temperature: num(body, 'temperature', 0, 2),
    topP: num(body, 'top_p', 0, 1),
    stop,
    ...(tools ? { tools } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(typeof body.parallel_tool_calls === 'boolean' && tools ? { parallelToolCalls: body.parallel_tool_calls } : {}),
    usesTools: !!tools || messages.some((x) => x.role === 'tool' || !!x.toolCalls?.length),
    stream,
    includeUsage: stream && streamOptions.include_usage === true,
  };
}

/** Parses POST /v1/embeddings. */
export function parseEmbeddingRequest(body: unknown): ParsedEmbeddingRequest {
  if (!isObject(body)) throw invalid('The request body must be a JSON object.');
  const m = model(body);
  const input = typeof body.input === 'string' ? [body.input] : body.input;
  if (!Array.isArray(input) || input.length === 0 || input.length > 2048 || !input.every((s) => typeof s === 'string' && s.length > 0)) {
    throw invalid("'input' must be a non-empty string or an array of up to 2048 non-empty strings.", 'input');
  }
  if (body.encoding_format !== undefined && body.encoding_format !== 'float') throw invalid("Only 'encoding_format': 'float' is supported.", 'encoding_format');
  if (body.dimensions !== undefined) throw invalid("'dimensions' is not supported yet.", 'dimensions');
  return { model: m, input: input as string[] };
}

export const finishReason = (r: FinishReason): string =>
  r === 'length' ? 'length' : r === 'content_filter' ? 'content_filter' : r === 'tool_use' ? 'tool_calls' : 'stop';

export function usageBlock(u: Usage): { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined {
  if (u.source !== 'provider' || u.inputTokens === null) return undefined;
  const completion = u.outputTokens ?? 0;
  return { prompt_tokens: u.inputTokens, completion_tokens: completion, total_tokens: u.totalTokens ?? u.inputTokens + completion };
}

export const unixTime = (d: Date) => Math.floor(d.getTime() / 1000);

/** Serializes one SSE event. */
export const sse = (data: unknown) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

/**
 * The assistant message of a chat completion: text, or tool calls (content null when there
 * is no text). Reasoning goes in `reasoning_content`, the field DeepSeek introduced and most
 * chat apps read (Open WebUI, LibreChat); clients that do not know it ignore it.
 */
export function assistantMessage(r: { content: string; reasoning?: string; toolCalls?: ToolCall[] }): Record<string, unknown> {
  const reasoning = r.reasoning ? { reasoning_content: r.reasoning } : {};
  if (!r.toolCalls?.length) return { role: 'assistant', content: r.content, ...reasoning };
  return {
    role: 'assistant',
    content: r.content || null,
    ...reasoning,
    tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
  };
}

/**
 * One streamed piece of a tool call, as OpenAI sends it: the first piece of a call
 * has its id, type and name; later pieces only append to `arguments`.
 */
export function toolCallDelta(e: { index: number; id?: string; name?: string; arguments?: string }): Record<string, unknown> {
  const fn: Record<string, string> = {};
  if (e.name !== undefined) fn.name = e.name;
  if (e.arguments !== undefined || e.id !== undefined) fn.arguments = e.arguments ?? '';
  return { index: e.index, ...(e.id !== undefined ? { id: e.id, type: 'function' } : {}), function: fn };
}
