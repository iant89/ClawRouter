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

import { AppError, parse, type Validator } from '@clawrouter/core';
import { jsonDepthExceeds } from '@clawrouter/gateway';
import type { RequestContext } from './context.ts';

export const DEFAULT_BODY_LIMIT = 64 * 1024;

/** `details.code` and `details.limit` tell programs which request limit (SEC-006) refused a body. */
const limitDetails = (limit: string) => ({ details: { code: 'request_limit', limit, param: null } });
const tooLarge = (limit: number) => new AppError('VALIDATION_ERROR', `Request body is too large (limit ${formatBytes(limit)}).`, limitDetails('maxRequestBytes'));
const round = (n: number) => Math.round(n * 100) / 100;
const formatBytes = (n: number) => (n >= 1024 * 1024 ? `${round(n / (1024 * 1024))} MB` : `${round(n / 1024)} KB`);

/**
 * Reads the body as text, stopping as soon as it exceeds `limit` bytes. The
 * declared Content-Length is checked first, but a chunked body has none, so the
 * stream itself is counted: an oversized body is never buffered in full.
 */
export async function readBodyText(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > limit) throw tooLarge(limit);
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(limit);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Reads a JSON body without a schema. Requires `Content-Type: application/json`,
 * which browsers cannot send cross-site without a CORS preflight (CSRF defence).
 */
export async function readJsonValue(ctx: RequestContext, limit = DEFAULT_BODY_LIMIT, options: { maxDepth?: number } = {}): Promise<unknown> {
  const type = ctx.request.headers.get('content-type') ?? '';
  if (!/^application\/json(\s*;|$)/i.test(type)) {
    throw new AppError('VALIDATION_ERROR', 'Content-Type must be application/json.');
  }
  const text = await readBodyText(ctx.request, limit);
  // Counted before parsing, so a deeply nested body is never built in memory.
  if (options.maxDepth !== undefined && jsonDepthExceeds(text, options.maxDepth)) {
    throw new AppError('VALIDATION_ERROR', `Request body is nested too deeply (limit ${options.maxDepth} levels).`, limitDetails('maxJsonDepth'));
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Includes absurdly deep nesting (the parser gives up): never a 500.
    throw new AppError('VALIDATION_ERROR', 'Request body is not valid JSON.');
  }
}

/** Reads and validates a JSON body (administration API). */
export async function readJson<T>(ctx: RequestContext, validator: Validator<T>, limit = DEFAULT_BODY_LIMIT): Promise<T> {
  return parse(validator, await readJsonValue(ctx, limit));
}
