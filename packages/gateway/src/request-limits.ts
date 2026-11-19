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
import type { ModelCost, RequestLimits } from '@clawrouter/shared';
import type { ParsedChatRequest, ParsedEmbeddingRequest } from './openai.ts';

/**
 * Request resource limits (SEC-006), checked on the normalized request, so they
 * apply the same way to Chat Completions, Responses and Messages. Every refusal
 * is a 400 with `details.code: 'request_limit'` and the limit's name in
 * `details.limit`, so programs can tell which one was reached.
 */
export function limitError(limit: keyof RequestLimits | 'maxEstimatedCostPerRequest', message: string, param: string | null): AppError {
  return new AppError('VALIDATION_ERROR', message, {
    expose: true,
    details: { param, code: 'request_limit', limit, issues: param ? [{ path: param, message }] : [] },
  });
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** About four characters per token, as everywhere else in the gateway. */
const tokens = (chars: number) => Math.ceil(chars / 4);

/** Estimated input tokens of a chat request: message text, tool calls and tool definitions. */
export function estimateChatInput(req: ParsedChatRequest): number {
  let chars = 0;
  for (const m of req.messages) {
    chars += m.content.length;
    for (const c of m.toolCalls ?? []) chars += c.name.length + c.arguments.length;
  }
  if (req.tools) chars += JSON.stringify(req.tools).length;
  return tokens(chars);
}

/** Width and height from a PNG, GIF, WebP or JPEG header; null when the header cannot be read. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const b = bytes;
  const u16be = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const u16le = (i: number) => b[i]! | (b[i + 1]! << 8);
  const u24le = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
  const u32be = (i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: u32be(16), height: u32be(20) };
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: u16le(6), height: u16le(8) };
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (chunk === 'VP8X') return { width: u24le(24) + 1, height: u24le(27) + 1 };
    if (chunk === 'VP8 ') return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      // Start-of-frame markers carry the size (not DHT c4, JPG c8, DAC cc).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: u16be(i + 7), height: u16be(i + 5) };
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      i += 2 + u16be(i + 2);
    }
    return null;
  }
  return null;
}

/**
 * Checks a parsed chat request against the limits and returns it with its
 * output limit applied: a larger `max_tokens` is lowered to `maxOutputTokens`
 * (and to what `maxTokensPerRequest` leaves after the input), a missing one set.
 */
export function enforceChatLimits(req: ParsedChatRequest, l: RequestLimits): ParsedChatRequest {
  if (req.messages.length > l.maxMessages) {
    throw limitError('maxMessages', `The request has ${fmt(req.messages.length)} messages; at most ${fmt(l.maxMessages)} are allowed.`, 'messages');
  }
  let parts = 0;
  let images = 0;
  req.messages.forEach((m, i) => {
    parts += m.parts?.length ?? 1;
    for (const p of m.parts ?? []) {
      if (p.type !== 'image') continue;
      images += 1;
      if (p.source.kind !== 'data') continue;
      const bytes = Buffer.from(p.source.data, 'base64');
      if (bytes.byteLength > l.maxImageBytes) {
        throw limitError('maxImageBytes', `An image is ${fmt(bytes.byteLength)} bytes; at most ${fmt(l.maxImageBytes)} are allowed.`, `messages[${i}]`);
      }
      const size = imageSize(bytes);
      if (!size) throw limitError('maxImageDimension', 'An image could not be read (its size is not in a PNG, JPEG, GIF or WebP header).', `messages[${i}]`);
      if (size.width > l.maxImageDimension || size.height > l.maxImageDimension) {
        throw limitError('maxImageDimension', `An image is ${fmt(size.width)} × ${fmt(size.height)} pixels; at most ${fmt(l.maxImageDimension)} pixels on a side are allowed.`, `messages[${i}]`);
      }
    }
  });
  if (parts > l.maxContentParts) throw limitError('maxContentParts', `The request has ${fmt(parts)} content parts; at most ${fmt(l.maxContentParts)} are allowed.`, 'messages');
  if (images > l.maxImages) throw limitError('maxImages', `The request has ${fmt(images)} images; at most ${fmt(l.maxImages)} are allowed.`, 'messages');
  if (req.tools) {
    if (req.tools.length > l.maxToolDefinitions) throw limitError('maxToolDefinitions', `The request offers ${fmt(req.tools.length)} tools; at most ${fmt(l.maxToolDefinitions)} are allowed.`, 'tools');
    const bytes = Buffer.byteLength(JSON.stringify(req.tools));
    if (bytes > l.maxToolSchemaBytes) throw limitError('maxToolSchemaBytes', `The tool definitions are ${fmt(bytes)} bytes; at most ${fmt(l.maxToolSchemaBytes)} are allowed.`, 'tools');
  }
  const input = estimateChatInput(req);
  if (l.maxInputTokens !== null && input > l.maxInputTokens) {
    throw limitError('maxInputTokens', `The request has about ${fmt(input)} input tokens; at most ${fmt(l.maxInputTokens)} are allowed.`, 'messages');
  }
  let maxTokens = req.maxTokens;
  if (l.maxOutputTokens !== null) maxTokens = Math.min(maxTokens ?? l.maxOutputTokens, l.maxOutputTokens);
  if (l.maxTokensPerRequest !== null) {
    const room = l.maxTokensPerRequest - input;
    if (room < 1) throw limitError('maxTokensPerRequest', `The request has about ${fmt(input)} input tokens, which leaves no room for an answer within ${fmt(l.maxTokensPerRequest)} tokens per request.`, 'messages');
    maxTokens = Math.min(maxTokens ?? room, room);
  }
  return maxTokens === req.maxTokens ? req : { ...req, maxTokens };
}

/** Embeddings: only the input-token limit applies. */
export function enforceEmbeddingLimits(req: ParsedEmbeddingRequest, l: RequestLimits): void {
  const input = tokens(req.input.reduce((n, s) => n + s.length, 0));
  if (l.maxInputTokens !== null && input > l.maxInputTokens) {
    throw limitError('maxInputTokens', `The input has about ${fmt(input)} tokens; at most ${fmt(l.maxInputTokens)} are allowed.`, 'input');
  }
}

/** Estimated cost of a request on a model: input estimate and the most it may write. Null when unpriced. */
export function estimateRequestCost(cost: ModelCost | null, inputTokens: number, maxOutputTokens: number): number | null {
  if (!cost || (cost.inputPerMTok === null && cost.outputPerMTok === null)) return null;
  return (inputTokens / 1e6) * (cost.inputPerMTok ?? 0) + (maxOutputTokens / 1e6) * (cost.outputPerMTok ?? 0);
}

/**
 * Nesting depth of a JSON text, counted without parsing (strings are skipped), so
 * a deeply nested body is refused before the parser builds it. Returns as soon as
 * `max` is passed.
 */
export function jsonDepthExceeds(text: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i += 1; // backslash: skip the escaped character
      else if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) {
      depth += 1;
      if (depth > max) return true;
    } else if (c === 0x7d || c === 0x5d) depth -= 1;
  }
  return false;
}
