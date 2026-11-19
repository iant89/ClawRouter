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

import { CSRF_HEADER, isApiErrorBody, NOTICE_HEADER, REQUEST_ID_HEADER } from '@clawrouter/shared';
import { apiGet, ApiClientError, reportUnauthorized } from './api-client.ts';

/** A model or alias the chosen key may use (as /v1/models lists it). */
export interface PlaygroundModel {
  id: string;
  ownedBy: string;
}

export const fetchPlaygroundModels = (keyId: string, signal?: AbortSignal) =>
  apiGet<PlaygroundModel[]>(`/api/playground/models?keyId=${encodeURIComponent(keyId)}`, { signal });

export interface PlaygroundMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PlaygroundSettings {
  keyId: string;
  model: string;
  stream: boolean;
  temperature: number | null;
  maxTokens: number | null;
}

/** What the gateway said about one answer. */
export interface PlaygroundAnswer {
  content: string;
  /** The model that answered (`provider/model`), from X-ClawRouter-Model. */
  model: string | null;
  /** Provider calls made, retries and failovers included. */
  attempts: number | null;
  requestId: string | null;
  notices: { kind: string; icon: string; text: string }[];
  inputTokens: number | null;
  outputTokens: number | null;
  finishReason: string | null;
  /** Until the first byte, then until the end. */
  firstByteMs: number;
  totalMs: number;
  /** The stream ended with an error event after it started. */
  interrupted: string | null;
}

type Chunk = {
  choices?: { delta?: { content?: string | null }; message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string };
};

function readNotices(res: Response): PlaygroundAnswer['notices'] {
  const raw = res.headers.get(NOTICE_HEADER);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as PlaygroundAnswer['notices'];
  } catch {
    return [];
  }
}

/**
 * Sends the conversation through the gateway as the chosen key (the session
 * proves who you are; the key's secret never reaches the browser). Streamed text
 * goes to `onText` as it arrives. Nothing is stored anywhere: the conversation
 * lives in the page.
 */
export async function sendPlaygroundChat(
  settings: PlaygroundSettings, messages: PlaygroundMessage[], onText: (soFar: string) => void, signal: AbortSignal,
): Promise<PlaygroundAnswer> {
  const request = {
    model: settings.model,
    messages,
    stream: settings.stream,
    ...(settings.stream ? { stream_options: { include_usage: true } } : {}),
    ...(settings.temperature !== null ? { temperature: settings.temperature } : {}),
    ...(settings.maxTokens !== null ? { max_tokens: settings.maxTokens } : {}),
  };
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch('/api/playground/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', [CSRF_HEADER]: '1' },
      body: JSON.stringify({ keyId: settings.keyId, request }),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiClientError('NETWORK_ERROR', 'Cannot reach the ClawRouter server.', 0, null);
  }
  const firstByteMs = Math.round(performance.now() - started);
  const requestId = res.headers.get(REQUEST_ID_HEADER);
  if (!res.ok) {
    if (res.status === 401) reportUnauthorized();
    const body: unknown = await res.json().catch(() => null);
    if (isApiErrorBody(body)) {
      const e = body.error;
      const { issues, ...details } = e.details ?? {};
      throw new ApiClientError(e.code, e.message, res.status, e.requestId ?? requestId, issues ?? [], Number(res.headers.get('retry-after')) || null, details);
    }
    throw new ApiClientError('INVALID_RESPONSE', `The server answered ${res.status}.`, res.status, requestId);
  }

  const answer: PlaygroundAnswer = {
    content: '', model: res.headers.get('x-clawrouter-model'), attempts: Number(res.headers.get('x-clawrouter-attempts')) || null, requestId,
    notices: readNotices(res), inputTokens: null, outputTokens: null, finishReason: null, firstByteMs, totalMs: 0, interrupted: null,
  };
  const takeUsage = (u: Chunk['usage']) => {
    if (!u) return;
    answer.inputTokens = u.prompt_tokens ?? null;
    answer.outputTokens = u.completion_tokens ?? null;
  };

  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const body = (await res.json()) as Chunk;
    answer.content = body.choices?.[0]?.message?.content ?? '';
    answer.finishReason = body.choices?.[0]?.finish_reason ?? null;
    takeUsage(body.usage);
    onText(answer.content);
    answer.totalMs = Math.round(performance.now() - started);
    return answer;
  }

  // Server-sent events: `data: {...}` lines separated by blank lines, ending with `data: [DONE]`.
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  const handle = (line: string) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let chunk: Chunk;
    try {
      chunk = JSON.parse(payload) as Chunk;
    } catch {
      return;
    }
    if (chunk.error) {
      answer.interrupted = chunk.error.message ?? 'The stream ended with an error.';
      return;
    }
    const choice = chunk.choices?.[0];
    if (choice?.delta?.content) {
      answer.content += choice.delta.content;
      onText(answer.content);
    }
    if (choice?.finish_reason) answer.finishReason = choice.finish_reason;
    takeUsage(chunk.usage);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach(handle);
  }
  handle(buffer);
  answer.totalMs = Math.round(performance.now() - started);
  return answer;
}
