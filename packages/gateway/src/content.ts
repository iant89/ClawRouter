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

import { scrubSecrets } from '@clawrouter/core';
import type { ChatMessage, MessagePart, ToolCall } from '@clawrouter/providers';
import type { RequestAttachment, RequestContent, RequestContentMessage, RequestToolCall } from '@clawrouter/shared';

/** The most stored per request (SEC-009): longer conversations lose their oldest message text first. */
export const MAX_CONTENT_BYTES = 1024 * 1024;
/** The most kept of one text (a message, a tool's arguments, the reply). */
const MAX_TEXT_CHARS = 200_000;

type Stored = Omit<RequestContent, 'requestId' | 'storedAt'>;

/** Secret-shaped strings removed, and cut to the per-text limit. */
function text(value: string, onCut: () => void): string {
  const clean = scrubSecrets(value);
  if (clean.length <= MAX_TEXT_CHARS) return clean;
  onCut();
  return `${clean.slice(0, MAX_TEXT_CHARS)}…`;
}

/** Decoded size of base64 data without decoding it. */
const base64Bytes = (data: string) => Math.max(0, Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0));

/** What is known of a media part; the data itself is never kept. */
function attachmentOf(p: Exclude<MessagePart, { type: 'text' }>): RequestAttachment {
  if (p.type === 'image') {
    if (p.source.kind === 'url') {
      let host: string | null = null;
      try {
        host = p.source.url.startsWith('data:') ? null : new URL(p.source.url).host;
      } catch {
        host = null;
      }
      return { type: 'image', mediaType: null, bytes: null, name: host };
    }
    return { type: 'image', mediaType: p.source.mediaType, bytes: base64Bytes(p.source.data), name: null };
  }
  if (p.type === 'audio') return { type: 'audio', mediaType: p.format === 'wav' ? 'audio/wav' : 'audio/mpeg', bytes: base64Bytes(p.data), name: null };
  return { type: 'pdf', mediaType: 'application/pdf', bytes: base64Bytes(p.data), name: p.filename ? scrubSecrets(p.filename).slice(0, 200) : null };
}

const toolCalls = (calls: readonly ToolCall[] | undefined, onCut: () => void): RequestToolCall[] =>
  (calls ?? []).map((c) => ({ id: c.id.slice(0, 300), name: c.name.slice(0, 200), arguments: text(c.arguments, onCut) }));

/**
 * The prompt and reply of one request as Full request logging stores them:
 * the messages ClawRouter passed on (notice lines already removed), tool names,
 * tool calls and attachment details (never the attachment), with secret-shaped
 * text removed and the whole at most MAX_CONTENT_BYTES.
 */
export class ContentRecorder {
  private messages: RequestContentMessage[] = [];
  private input: string[] | undefined;
  private tools: string[] = [];
  private reply = { content: '', reasoning: '', toolCalls: new Map<number, RequestToolCall>(), finishReason: null as string | null, embeddings: undefined as number | undefined };
  private answered = false;
  private truncated = false;
  private readonly cut = () => {
    this.truncated = true;
  };

  /** A chat request: its messages and the names of the tools it offers. */
  chat(messages: readonly ChatMessage[], tools: readonly { name: string }[] | undefined): void {
    this.messages = messages.map((m) => {
      const out: RequestContentMessage = { role: m.role, content: text(m.content, this.cut) };
      const calls = toolCalls(m.toolCalls, this.cut);
      if (calls.length) out.toolCalls = calls;
      if (m.toolCallId) out.toolCallId = m.toolCallId.slice(0, 300);
      const media = (m.parts ?? []).filter((p): p is Exclude<MessagePart, { type: 'text' }> => p.type !== 'text');
      if (media.length) out.attachments = media.map(attachmentOf);
      return out;
    });
    this.tools = (tools ?? []).map((t) => t.name.slice(0, 200));
  }

  /** An embedding request: the texts embedded. */
  embeddings(input: readonly string[]): void {
    this.input = input.map((s) => text(s, this.cut));
  }

  /** A whole answer (not streamed). */
  answer(a: { content: string; reasoning?: string | null; toolCalls?: readonly ToolCall[]; finishReason?: string | null }): void {
    this.answered = true;
    this.reply.content = a.content;
    this.reply.reasoning = a.reasoning ?? '';
    toolCalls(a.toolCalls, () => {}).forEach((c, i) => this.reply.toolCalls.set(i, c));
    this.reply.finishReason = a.finishReason ?? null;
  }

  /** Streamed pieces of the answer, as they are sent. */
  delta(piece: string): void {
    this.answered = true;
    if (this.reply.content.length < MAX_TEXT_CHARS * 2) this.reply.content += piece;
  }

  reasoning(piece: string): void {
    this.answered = true;
    if (this.reply.reasoning.length < MAX_TEXT_CHARS * 2) this.reply.reasoning += piece;
  }

  toolCall(e: { index: number; id?: string; name?: string; arguments?: string }): void {
    this.answered = true;
    const call = this.reply.toolCalls.get(e.index) ?? { id: '', name: '', arguments: '' };
    if (e.id) call.id = e.id.slice(0, 300);
    if (e.name) call.name = e.name.slice(0, 200);
    if (e.arguments && call.arguments.length < MAX_TEXT_CHARS * 2) call.arguments += e.arguments;
    this.reply.toolCalls.set(e.index, call);
  }

  finished(reason: string | null): void {
    this.reply.finishReason = reason;
  }

  embedded(count: number): void {
    this.answered = true;
    this.reply.embeddings = count;
  }

  /** The document to store: scrubbed and within MAX_CONTENT_BYTES. */
  build(): Stored {
    const response = this.answered
      ? {
        content: text(this.reply.content, this.cut),
        reasoning: this.reply.reasoning ? text(this.reply.reasoning, this.cut) : null,
        toolCalls: [...this.reply.toolCalls.entries()].sort(([a], [b]) => a - b).map(([, c]) => ({ ...c, arguments: text(c.arguments, this.cut) })),
        finishReason: this.reply.finishReason,
        ...(this.reply.embeddings !== undefined ? { embeddings: this.reply.embeddings } : {}),
      }
      : null;
    const doc: Stored = { messages: this.messages.map((m) => ({ ...m })), ...(this.input ? { input: [...this.input] } : {}), tools: this.tools, response, truncated: this.truncated };
    // Too large: the oldest message texts go first (the latest turn and the reply stay).
    let size = Buffer.byteLength(JSON.stringify(doc));
    for (let i = 0; size > MAX_CONTENT_BYTES && i < doc.messages.length - 1; i++) {
      const m = doc.messages[i]!;
      size -= Buffer.byteLength(JSON.stringify(m.content)) - 2;
      doc.messages[i] = { ...m, content: '', truncated: true };
      doc.truncated = true;
    }
    if (size > MAX_CONTENT_BYTES && doc.input) {
      doc.input = doc.input.map((s) => s.slice(0, 1000));
      doc.truncated = true;
    }
    if (Buffer.byteLength(JSON.stringify(doc)) > MAX_CONTENT_BYTES) {
      // Still too large (one huge last message or reply): keep the start of each.
      const share = Math.floor(MAX_CONTENT_BYTES / 4 / Math.max(1, doc.messages.length + 1));
      doc.messages = doc.messages.map((m) => (m.content.length > share ? { ...m, content: `${m.content.slice(0, share)}…`, truncated: true } : m));
      if (doc.response && doc.response.content.length > MAX_CONTENT_BYTES / 4) doc.response = { ...doc.response, content: `${doc.response.content.slice(0, MAX_CONTENT_BYTES / 4)}…` };
      doc.truncated = true;
    }
    return doc;
  }
}
