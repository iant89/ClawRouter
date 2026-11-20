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
import { invalidResponse, joinUrl, parseChunk, providerFetch, readJson } from '../http.ts';
import { list, obj, objects, text, tokens, vector, type Json } from '../untrusted.ts';
import { parseSse } from '../sse.ts';
import type { ChatMessage, ChatRequest, MessagePart, ToolCall, ToolChoice, ChatResponse, EmbeddingResponse, FinishReason, ProviderAdapter, ProviderCallContext, StreamEvent, Usage } from '../types.ts';
import { baseValidation, connectionChecks, guessKind, splitSystem } from './common.ts';

/**
 * A Gemini answer or stream chunk: `candidates[0].content.parts`, `usageMetadata` and
 * `modelVersion`. Every field is read as untrusted (wrong types count as absent).
 */
type GeminiResponse = Json;

const finish = (reason: unknown): FinishReason =>
  reason === 'STOP' ? 'stop' : reason === 'MAX_TOKENS' ? 'length' : reason === 'SAFETY' || reason === 'RECITATION' || reason === 'BLOCKLIST' || reason === 'PROHIBITED_CONTENT' ? 'content_filter' : 'other';

/**
 * `usageMetadata`: promptTokenCount, candidatesTokenCount, thoughtsTokenCount (thinking models'
 * reasoning tokens) and totalTokenCount. Output tokens include the reasoning: Google bills it as output.
 */
const usageOf = (value: unknown): Usage => {
  const u = obj(value);
  if (!u) return { inputTokens: null, outputTokens: null, totalTokens: null, source: 'none' };
  const answer = tokens(u.candidatesTokenCount);
  const thoughts = tokens(u.thoughtsTokenCount);
  const output = answer === null && thoughts === null ? null : (answer ?? 0) + (thoughts ?? 0);
  return { inputTokens: tokens(u.promptTokenCount), outputTokens: output, totalTokens: tokens(u.totalTokenCount), source: 'provider' };
};

/** The first candidate's parts (`{ text, thought, functionCall: { name, args }, thoughtSignature }`). */
const partsOf = (r: GeminiResponse) => objects(obj(obj(list(r.candidates)[0])?.content)?.parts);
const firstFinish = (r: GeminiResponse) => obj(list(r.candidates)[0])?.finishReason;

const info: ProviderKindInfo = {
  kind: 'google',
  displayName: 'Google',
  description: 'Google Gemini API (Generative Language API).',
  defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta',
  endpointRequired: false,
  apiKeyRequired: true,
  capabilities: ['CHAT', 'CODING', 'REASONING', 'VISION', 'EMBEDDINGS', 'TOOL_USE'],
  supportsStreaming: true,
  // Everything inline (Gemini cannot fetch arbitrary image URLs).
  inputMedia: ['image_data', 'audio', 'pdf'],
};

/** The key goes in a header, never in the URL (spec §29). */
const headers = (ctx: ProviderCallContext): Record<string, string> => ({
  'content-type': 'application/json',
  accept: 'application/json',
  ...(ctx.apiKey ? { 'x-goog-api-key': ctx.apiKey } : {}),
});

const modelPath = (model: string) => `/models/${encodeURIComponent(model.replace(/^models\//, ''))}`;

/**
 * Models from before thinking (Gemini 1.x and 2.0, Gemma 1–3): they may refuse a
 * thinking setting. Every other Gemini chat model thinks (Google's list, 2026-11-19).
 */
const NO_THINKING = /^(models\/)?(gemini-(1\.|2\.0)|gemma-[123]-)/i;

function body(req: ChatRequest) {
  const { system, rest } = splitSystem(req.messages);
  const generationConfig = {
    // Thinking models send their thought summary only when asked; it is passed on as reasoning, apart from the answer.
    ...(NO_THINKING.test(req.model) ? {} : { thinkingConfig: { includeThoughts: true } }),
    ...(req.maxTokens !== undefined ? { maxOutputTokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { topP: req.topP } : {}),
    ...(req.stop?.length ? { stopSequences: req.stop } : {}),
  };
  return {
    contents: geminiContents(rest),
    ...(req.tools?.length ? { tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), ...(t.parameters ? { parametersJsonSchema: t.parameters } : {}) })) }] } : {}),
    ...(req.tools?.length && req.toolChoice !== undefined ? { toolConfig: { functionCallingConfig: geminiToolChoice(req.toolChoice) } } : {}),
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
  };
}

/** The answer's text; thought summaries (reasoning) are left out. */
const textOf = (r: GeminiResponse) => partsOf(r).filter((p) => p.thought !== true).map((p) => text(p.text) ?? '').join('');
/** Thought summaries from a thinking model: its reasoning, passed on apart from the answer. */
const thoughtsOf = (r: GeminiResponse) => partsOf(r).filter((p) => p.thought === true).map((p) => text(p.text) ?? '').join('');

/**
 * Google models that list generateContent but do not answer a chat in text: music
 * (Lyria), images (Imagen, Nano Banana, *-image), video (Veo), speech, live audio,
 * transcription, computer use, and agents served only by Google's Interactions API
 * (Deep Research, Antigravity: "This model only supports Interactions API", live
 * 2026-11-19). Checked against Google's list of 65 models that day.
 */
const NOT_CHAT = /(lyria|banana|imagen|veo|image|tts|native-audio|live|transcribe|computer-use|deep-research|antigravity|^models\/aqa$)/i;

/** Most model-list pages followed: Google lists fewer than 100 models today. */
const MAX_MODEL_PAGES = 10;

async function listModels(ctx: ProviderCallContext) {
  const models: Json[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_MODEL_PAGES; page++) {
    const query = `/models?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await providerFetch(ctx, joinUrl(ctx.endpoint, query), { method: 'GET', headers: headers(ctx) });
    const json = await readJson(res, ctx.apiKey);
    if (!Array.isArray(json.models)) throw invalidResponse('model list has no "models" array');
    models.push(...objects(json.models));
    pageToken = text(json.nextPageToken) || null;
    if (!pageToken) break;
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);
  return models
    .filter((m): m is Json & { name: string } => typeof m.name === 'string' && m.name.replace(/^models\//, '') !== '')
    .map((m) => {
      const methods = list(m.supportedGenerationMethods);
      // Speech, image and other non-text models also offer generateContent: their names give them away.
      const kind = guessKind(m.name) === 'other' || NOT_CHAT.test(m.name) ? 'other' as const
        : methods.includes('generateContent') ? 'chat' as const : methods.includes('embedContent') ? 'embedding' as const : methods.length ? 'other' as const : guessKind(m.name);
      return {
        id: m.name.replace(/^models\//, ''),
        displayName: text(m.displayName) ?? null,
        contextLength: num(m.inputTokenLimit),
        maxOutputTokens: num(m.outputTokenLimit),
        kind,
        // Gemini and Gemma chat models all take images (the list does not say so per model).
        ...(kind === 'chat' ? { vision: true } : {}),
      };
    });
}

export const googleAdapter: ProviderAdapter = {
  info,
  capabilities: info.capabilities,
  validateConfiguration: (config) => baseValidation(config, true),
  listModels,
  ...connectionChecks(listModels),

  async sendRequest(ctx, req): Promise<ChatResponse> {
    const res = await providerFetch(ctx, joinUrl(ctx.endpoint, `${modelPath(req.model)}:generateContent`), { method: 'POST', headers: headers(ctx), body: JSON.stringify(body(req)) });
    const json = await readJson(res, ctx.apiKey);
    if (!Array.isArray(json.candidates)) throw invalidResponse('no candidates in response');
    const toolCalls = toolCallsOf(json);
    const reasoning = thoughtsOf(json);
    return {
      model: text(json.modelVersion) || req.model, content: textOf(json), usage: usageOf(json.usageMetadata),
      ...(reasoning ? { reasoning } : {}),
      // Gemini says STOP after a function call; clients expect tool_calls.
      finishReason: toolCalls.length ? 'tool_use' : finish(firstFinish(json)),
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  },

  async embed(ctx, req): Promise<EmbeddingResponse> {
    const name = `models/${req.model.replace(/^models\//, '')}`;
    const res = await providerFetch(ctx, joinUrl(ctx.endpoint, `${modelPath(req.model)}:batchEmbedContents`), {
      method: 'POST', headers: headers(ctx),
      body: JSON.stringify({ requests: req.input.map((text) => ({ model: name, content: { parts: [{ text }] } })) }),
    });
    const json = await readJson(res, ctx.apiKey);
    const vectors = list(json.embeddings).map((e) => vector(obj(e)?.values));
    if (!Array.isArray(json.embeddings) || vectors.length !== req.input.length || !vectors.every((v) => v !== null)) {
      throw invalidResponse('embeddings do not match the inputs');
    }
    // The Gemini API reports no token usage for embeddings.
    return { model: req.model, embeddings: vectors as number[][], usage: usageOf(undefined) };
  },

  async *sendStreamingRequest(ctx, req): AsyncGenerator<StreamEvent> {
    const res = await providerFetch(ctx, joinUrl(ctx.endpoint, `${modelPath(req.model)}:streamGenerateContent?alt=sse`), {
      method: 'POST', headers: { ...headers(ctx), accept: 'text/event-stream' }, body: JSON.stringify(body(req)),
    });
    if (!res.body) throw invalidResponse('empty stream');
    let reason: FinishReason = 'other';
    let usage: Usage = usageOf(undefined);
    let calls = 0;
    let model = req.model;
    for await (const event of parseSse(res.body, ctx.signal)) {
      const chunk = parseChunk(event.data);
      const thoughts = thoughtsOf(chunk);
      if (thoughts) yield { type: 'reasoning', text: thoughts };
      const answer = textOf(chunk);
      if (answer) yield { type: 'delta', text: answer };
      // Gemini sends each function call whole, in one chunk.
      for (const call of toolCallsOf(chunk)) yield { type: 'tool_call', index: calls++, id: call.id, name: call.name, arguments: call.arguments };
      const finished = firstFinish(chunk);
      if (finished) reason = finish(finished);
      if (obj(chunk.usageMetadata)) usage = usageOf(chunk.usageMetadata);
      model = text(chunk.modelVersion) || model;
    }
    yield { type: 'done', finishReason: calls ? 'tool_use' : reason, usage, model };
  },
};

/** A message part as a Gemini part. Image URLs never reach here (not in inputMedia). */
function geminiPart(p: MessagePart): Record<string, unknown> {
  switch (p.type) {
    case 'text': return { text: p.text };
    case 'image':
      if (p.source.kind === 'url') throw new Error('Gemini needs images inline');
      return { inlineData: { mimeType: p.source.mediaType, data: p.source.data } };
    case 'audio': return { inlineData: { mimeType: p.format === 'mp3' ? 'audio/mp3' : 'audio/wav', data: p.data } };
    case 'pdf': return { inlineData: { mimeType: 'application/pdf', data: p.data } };
  }
}

/**
 * Gemini 3 needs each function call's thought signature back on the next turn.
 * ClawRouter keeps no state between requests, so the signature travels inside the
 * tool call id the client receives and sends back: `call_<random>~<signature>`.
 */
const SIGNATURE_MARK = '~';
const callId = (signature: string | undefined) => `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}${signature ? SIGNATURE_MARK + signature : ''}`;
const signatureOf = (id: string): string | null => {
  const at = id.indexOf(SIGNATURE_MARK);
  return id.startsWith('call_') && at > 0 ? id.slice(at + 1) : null;
};

function toolCallsOf(r: GeminiResponse): ToolCall[] {
  return partsOf(r).flatMap((p) => {
    const call = obj(p.functionCall);
    const name = text(call?.name);
    return name === undefined ? [] : [{ id: callId(text(p.thoughtSignature)), name, arguments: JSON.stringify(call!.args ?? {}) }];
  });
}

const parseArgs = (text: string): unknown => {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return { arguments: text };
  }
};

/**
 * Messages as Gemini contents. Tool calls are `functionCall` parts of the model's
 * turn (with their thought signature); tool results are `functionResponse` parts of
 * a user turn, named after the call they answer. Results that follow each other share one turn.
 */
function geminiContents(messages: ChatMessage[]): { role: 'user' | 'model'; parts: Record<string, unknown>[] }[] {
  const names = new Map<string, string>();
  const out: { role: 'user' | 'model'; parts: Record<string, unknown>[] }[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      for (const c of m.toolCalls) names.set(c.id, c.name);
      out.push({
        role: 'model',
        parts: [
          ...(m.content ? [{ text: m.content }] : []),
          ...m.toolCalls.map((c) => {
            const signature = signatureOf(c.id);
            return { functionCall: { name: c.name, args: parseArgs(c.arguments) }, ...(signature ? { thoughtSignature: signature } : {}) };
          }),
        ],
      });
      continue;
    }
    if (m.role === 'tool') {
      const result = parseArgs(m.content);
      const response = typeof result === 'object' && result !== null && !Array.isArray(result) && !('arguments' in result && Object.keys(result).length === 1)
        ? result
        : { content: m.content };
      const part = { functionResponse: { name: names.get(m.toolCallId ?? '') ?? 'unknown_tool', response } };
      const last = out.at(-1);
      if (last?.role === 'user' && last.parts.every((p) => 'functionResponse' in p)) last.parts.push(part);
      else out.push({ role: 'user', parts: [part] });
      continue;
    }
    out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: m.parts ? m.parts.map(geminiPart) : [{ text: m.content }] });
  }
  return out;
}

function geminiToolChoice(choice: ToolChoice): Record<string, unknown> {
  if (choice === 'none') return { mode: 'NONE' };
  if (choice === 'required') return { mode: 'ANY' };
  if (typeof choice === 'object') return { mode: 'ANY', allowedFunctionNames: [choice.name] };
  return { mode: 'AUTO' };
}
