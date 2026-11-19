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

import type { Capability, MediaKind, ProviderKind, ProviderKindInfo } from '@clawrouter/shared';
import { invalidResponse, joinUrl, providerFetch, readJson } from '../http.ts';
import { parseSse } from '../sse.ts';
import type { ChatMessage, ChatRequest, ChatResponse, DiscoveredModel, EmbeddingResponse, MessagePart, ToolDefinition, FinishReason, ProviderAdapter, ProviderCallContext, StreamEvent, Usage } from '../types.ts';
import { baseValidation, connectionChecks, guessKind } from './common.ts';

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** OpenRouter: what the request cost, in US$ (credits). */
  cost?: number;
}

const finish = (reason: string | null | undefined): FinishReason =>
  reason === 'stop' ? 'stop' : reason === 'length' ? 'length' : reason === 'content_filter' ? 'content_filter' : reason === 'tool_calls' || reason === 'function_call' ? 'tool_use' : 'other';

const usageOf = (u: OpenAiUsage | undefined | null, reportsCost = false): Usage =>
  u ? {
    inputTokens: u.prompt_tokens ?? null, outputTokens: u.completion_tokens ?? null, totalTokens: u.total_tokens ?? null, source: 'provider',
    ...(reportsCost && typeof u.cost === 'number' && Number.isFinite(u.cost) && u.cost >= 0 ? { costUsd: u.cost } : {}),
  } : { inputTokens: null, outputTokens: null, totalTokens: null, source: 'none' };

/** A message part in OpenAI's format (the format clients send it in). */
function openAiPart(p: MessagePart): Record<string, unknown> {
  switch (p.type) {
    case 'text': return { type: 'text', text: p.text };
    case 'image': return { type: 'image_url', image_url: { url: p.source.kind === 'url' ? p.source.url : `data:${p.source.mediaType};base64,${p.source.data}`, ...(p.detail ? { detail: p.detail } : {}) } };
    case 'audio': return { type: 'input_audio', input_audio: { data: p.data, format: p.format } };
    case 'pdf': return { type: 'file', file: { filename: p.filename ?? 'document.pdf', file_data: `data:application/pdf;base64,${p.data}` } };
  }
}

/** A tool call as OpenAI-style APIs send it. */
interface OpenAiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
  /** Google (OpenAI-compatible endpoint): Gemini 3's thought signature, needed back on the next turn. */
  extra_content?: { google?: { thought_signature?: string } };
}

/** A message in OpenAI's format, tool calls and tool results included. */
function openAiMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: splitSignature(m.toolCallId ?? '').id, content: m.content };
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant', content: m.content || null,
      tool_calls: m.toolCalls.map((c) => {
        const { id, signature } = splitSignature(c.id);
        return { id, type: 'function', function: { name: c.name, arguments: c.arguments }, ...(signature ? { extra_content: { google: { thought_signature: signature } } } : {}) };
      }),
    };
  }
  return { role: m.role, content: m.parts ? m.parts.map(openAiPart) : m.content };
}

const openAiTool = (t: ToolDefinition) => ({
  type: 'function',
  function: { name: t.name, ...(t.description ? { description: t.description } : {}), ...(t.parameters ? { parameters: t.parameters } : {}), ...(t.strict !== undefined ? { strict: t.strict } : {}) },
});

/**
 * Gemini 3, through Google's OpenAI-compatible endpoint, needs each tool call's
 * thought signature back on the next turn. ClawRouter keeps no state, so the signature
 * travels in the tool call id the client receives (`<id>~<signature>`), as in the
 * native Gemini adapter, and goes back to Google in `extra_content`.
 */
const SIGNATURE_MARK = '~';
function withSignature(id: string, call: OpenAiToolCall): string {
  const signature = call.extra_content?.google?.thought_signature;
  return typeof signature === 'string' && signature ? `${id}${SIGNATURE_MARK}${signature}` : id;
}
function splitSignature(id: string): { id: string; signature: string | null } {
  const at = id.indexOf(SIGNATURE_MARK);
  return at > 0 ? { id: id.slice(0, at), signature: id.slice(at + 1) } : { id, signature: null };
}

/** A listed model's name: Groq says `name`, Google says `display_name`. */
const nameOf = (m: { name?: unknown; display_name?: unknown }): string | null => {
  const n = typeof m.name === 'string' && m.name.trim() ? m.name : typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name : null;
  return n ? n.trim().slice(0, 200) : null;
};

/** A model in an OpenAI-style list. OpenAI sends only `id`; Groq and OpenRouter add the rest. */
interface ListedOpenAiModel {
  id?: unknown;
  name?: unknown;
  /** Google's OpenAI-compatible endpoint. */
  display_name?: unknown;
  active?: unknown;
  context_window?: unknown;
  max_completion_tokens?: unknown;
  input_modalities?: unknown;
  output_modalities?: unknown;
  /** Groq: e.g. ["tools", "json_mode", "reasoning"]. */
  supported_features?: unknown;
  /** OpenRouter: the context window, the best provider's limits, and what goes in and out. */
  context_length?: unknown;
  top_provider?: { context_length?: unknown; max_completion_tokens?: unknown } | null;
  architecture?: { input_modalities?: unknown; output_modalities?: unknown } | null;
  /** OpenRouter: request parameters the model takes, e.g. ["tools", "max_tokens", …]. */
  supported_parameters?: unknown;
  /** OpenRouter: the APIs that serve it, e.g. ["/api/v1/chat/completions", …]; batch variants only ["/api/v1/batches"]. */
  endpoints?: unknown;
  /** OpenRouter: the day the model goes away (YYYY-MM-DD). */
  expiration_date?: unknown;
  /** US$ per token, as decimal strings. */
  pricing?: { prompt?: unknown; completion?: unknown } | null;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const strings = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null);
/** "0.00000015" US$ per token -> 0.15 per million tokens (null when absent or not a number). */
const perMillion = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : null;
};

export interface OpenAiStyleOptions {
  kind: Extract<ProviderKind, 'openai' | 'groq' | 'openrouter' | 'openai_compatible'>;
  displayName: string;
  description: string;
  defaultEndpoint: string | null;
  apiKeyRequired: boolean;
  capabilities: Capability[];
  /** Media this API accepts in messages (sent in OpenAI's own part format). */
  inputMedia: MediaKind[];
  /** Field for the answer length: `max_completion_tokens` (OpenAI, Groq) or the classic `max_tokens` (most compatible servers). */
  maxTokensField: 'max_completion_tokens' | 'max_tokens';
  /** Ask for usage in streams with `stream_options` (OpenAI). Groq sends it in `x_groq.usage` without being asked; both are read. */
  streamOptions: boolean;
  /** Sent with every call (OpenRouter's app attribution). */
  extraHeaders?: Record<string, string>;
  /** The provider reports what each request cost in `usage.cost`, in US$ (OpenRouter). */
  reportsCost?: boolean;
  /** For expiry dates in model lists. */
  now?: () => Date;
}

/** OpenAI Chat Completions, and the many servers that implement the same API. */
export function createOpenAiStyleAdapter(options: OpenAiStyleOptions): ProviderAdapter {
  const info: ProviderKindInfo = {
    kind: options.kind,
    displayName: options.displayName,
    description: options.description,
    defaultEndpoint: options.defaultEndpoint,
    endpointRequired: options.defaultEndpoint === null,
    apiKeyRequired: options.apiKeyRequired,
    capabilities: options.capabilities,
    supportsStreaming: true,
    inputMedia: options.inputMedia,
  };

  const headers = (ctx: ProviderCallContext): Record<string, string> => ({
    'content-type': 'application/json',
    accept: 'application/json',
    ...options.extraHeaders,
    ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {}),
  });
  const usage = (u: OpenAiUsage | undefined | null) => usageOf(u, options.reportsCost);

  const body = (req: ChatRequest, stream: boolean) => ({
    model: req.model,
    messages: req.messages.map(openAiMessage),
    ...(req.tools?.length ? { tools: req.tools.map(openAiTool) } : {}),
    ...(req.toolChoice !== undefined ? { tool_choice: typeof req.toolChoice === 'string' ? req.toolChoice : { type: 'function', function: { name: req.toolChoice.name } } } : {}),
    ...(req.parallelToolCalls !== undefined && req.tools?.length ? { parallel_tool_calls: req.parallelToolCalls } : {}),
    ...(req.maxTokens !== undefined ? { [options.maxTokensField]: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    ...(req.stop?.length ? { stop: req.stop } : {}),
    stream,
    ...(stream && options.streamOptions ? { stream_options: { include_usage: true } } : {}),
  });

  async function listModels(ctx: ProviderCallContext): Promise<DiscoveredModel[]> {
    const res = await providerFetch(ctx, joinUrl(ctx.endpoint, '/models'), { method: 'GET', headers: headers(ctx) });
    const json = await readJson<{ data?: ListedOpenAiModel[] }>(res, ctx.apiKey);
    if (!Array.isArray(json.data)) throw invalidResponse('model list has no "data" array');
    const today = (options.now?.() ?? new Date()).toISOString().slice(0, 10);
    return json.data
      // Groq marks retired models `active: false`; OpenRouter gives an expiration date. Neither can be called afterwards.
      .filter((m): m is ListedOpenAiModel & { id: string } => typeof m.id === 'string' && m.active !== false
        && !(typeof m.expiration_date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(m.expiration_date) && m.expiration_date.slice(0, 10) < today))
      .map((m) => {
        const inputs = strings(m.input_modalities) ?? strings(m.architecture?.input_modalities);
        const outputs = strings(m.output_modalities) ?? strings(m.architecture?.output_modalities);
        const endpoints = strings(m.endpoints);
        // A model whose API list leaves out chat completions (OpenRouter's :batch variants) cannot answer a chat request.
        const chatServed = !endpoints || endpoints.some((e) => e.endsWith('/chat/completions'));
        // Groq and OpenRouter say what goes in and out: a model that does not answer in text (speech, transcription) is not a chat model.
        const kind = !chatServed || (outputs && !outputs.includes('text')) ? 'other' : guessKind(m.id);
        const features = strings(m.supported_features) ?? strings(m.supported_parameters);
        const input = perMillion(m.pricing?.prompt);
        const output = perMillion(m.pricing?.completion);
        return {
          // Google's OpenAI-compatible list says "models/gemini-…"; its API takes the name without the prefix too.
          id: m.id.replace(/^models\//, ''),
          displayName: nameOf(m),
          kind,
          // Groq (and some compatible servers) report these; OpenAI does not.
          contextLength: num(m.context_window) ?? num(m.context_length) ?? num(m.top_provider?.context_length),
          maxOutputTokens: num(m.max_completion_tokens) ?? num(m.top_provider?.max_completion_tokens),
          ...(inputs ? { vision: inputs.includes('image') } : {}),
          ...(features ? { tools: features.includes('tools') } : {}),
          ...(input !== null || output !== null ? { cost: { inputPerMTok: input, outputPerMTok: output } } : {}),
        };
      });
  }

  return {
    info,
    capabilities: options.capabilities,
    validateConfiguration: (config) => baseValidation(config, options.apiKeyRequired),
    listModels,
    ...connectionChecks(listModels),

    async sendRequest(ctx, req): Promise<ChatResponse> {
      const res = await providerFetch(ctx, joinUrl(ctx.endpoint, '/chat/completions'), { method: 'POST', headers: headers(ctx), body: JSON.stringify(body(req, false)) });
      const json = await readJson<{ model?: string; choices?: { message?: { content?: string | null; tool_calls?: OpenAiToolCall[] }; finish_reason?: string }[]; usage?: OpenAiUsage }>(res, ctx.apiKey);
      const choice = json.choices?.[0];
      if (!choice) throw invalidResponse('no choices in response');
      const toolCalls = (choice.message?.tool_calls ?? []).filter((c) => typeof c.function?.name === 'string').map((c, i) => ({
        id: withSignature(typeof c.id === 'string' && c.id ? c.id : `call_${i}`, c), name: c.function!.name!, arguments: typeof c.function!.arguments === 'string' ? c.function!.arguments : '{}',
      }));
      return {
        model: json.model ?? req.model, content: choice.message?.content ?? '', finishReason: finish(choice.finish_reason), usage: usage(json.usage),
        ...(toolCalls.length ? { toolCalls } : {}),
      };
    },

    async embed(ctx, req): Promise<EmbeddingResponse> {
      const res = await providerFetch(ctx, joinUrl(ctx.endpoint, '/embeddings'), { method: 'POST', headers: headers(ctx), body: JSON.stringify({ model: req.model, input: req.input }) });
      const json = await readJson<{ model?: string; data?: { embedding?: unknown; index?: number }[]; usage?: OpenAiUsage }>(res, ctx.apiKey);
      if (!Array.isArray(json.data)) throw invalidResponse('no "data" in embeddings response');
      const sorted = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (sorted.length !== req.input.length || !sorted.every((d) => Array.isArray(d.embedding))) throw invalidResponse('embeddings do not match the inputs');
      const u = json.usage;
      return {
        model: json.model ?? req.model,
        embeddings: sorted.map((d) => d.embedding as number[]),
        usage: u ? { inputTokens: u.prompt_tokens ?? null, outputTokens: 0, totalTokens: u.total_tokens ?? u.prompt_tokens ?? null, source: 'provider' } : usageOf(null),
      };
    },

    async *sendStreamingRequest(ctx, req): AsyncGenerator<StreamEvent> {
      const res = await providerFetch(ctx, joinUrl(ctx.endpoint, '/chat/completions'), {
        method: 'POST', headers: { ...headers(ctx), accept: 'text/event-stream' }, body: JSON.stringify(body(req, true)),
      });
      if (!res.body) throw invalidResponse('empty stream');
      let reason: FinishReason = 'other';
      let streamed: Usage = usageOf(null);
      let sawToolCall = false;
      let model = req.model;
      for await (const event of parseSse(res.body, ctx.signal)) {
        if (event.data === '[DONE]') break;
        let chunk: { model?: string; choices?: { delta?: { content?: string | null; tool_calls?: (OpenAiToolCall & { index?: number })[] }; finish_reason?: string | null }[]; usage?: OpenAiUsage | null; x_groq?: { usage?: OpenAiUsage | null } };
        try {
          chunk = JSON.parse(event.data);
        } catch {
          throw invalidResponse('malformed stream chunk');
        }
        if (chunk.model) model = chunk.model;
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) yield { type: 'delta', text: choice.delta.content };
        for (const t of choice?.delta?.tool_calls ?? []) {
          sawToolCall = true;
          yield {
            type: 'tool_call', index: typeof t.index === 'number' ? t.index : 0,
            ...(typeof t.id === 'string' && t.id ? { id: withSignature(t.id, t) } : {}),
            ...(typeof t.function?.name === 'string' && t.function.name ? { name: t.function.name } : {}),
            ...(typeof t.function?.arguments === 'string' && t.function.arguments ? { arguments: t.function.arguments } : {}),
          };
        }
        if (choice?.finish_reason) reason = finish(choice.finish_reason);
        const reported = chunk.usage ?? chunk.x_groq?.usage;
        if (reported) streamed = usage(reported);
      }
      // Google's stream ends tool calls with "stop"; clients expect tool_calls.
      yield { type: 'done', finishReason: sawToolCall && reason === 'stop' ? 'tool_use' : reason, usage: streamed, model };
    },
  };
}

export const openAiAdapter = createOpenAiStyleAdapter({
  kind: 'openai',
  displayName: 'OpenAI',
  description: 'OpenAI API (Chat Completions).',
  defaultEndpoint: 'https://api.openai.com/v1',
  apiKeyRequired: true,
  capabilities: ['CHAT', 'CODING', 'REASONING', 'VISION', 'EMBEDDINGS', 'TOOL_USE'],
  maxTokensField: 'max_completion_tokens',
  streamOptions: true,
  inputMedia: ['image_url', 'image_data', 'audio', 'pdf'],
});

export const openAiCompatibleAdapter = createOpenAiStyleAdapter({
  kind: 'openai_compatible',
  displayName: 'Local / OpenAI-compatible',
  description: 'Any server implementing the OpenAI Chat Completions API: Ollama, vLLM, LM Studio, llama.cpp, LiteLLM and others. The API key is optional.',
  defaultEndpoint: null,
  apiKeyRequired: false,
  capabilities: ['CHAT', 'CODING', 'EMBEDDINGS'],
  maxTokensField: 'max_tokens',
  streamOptions: false,
  // Ollama, vLLM, LM Studio and others take OpenAI-style images; audio and files vary too much.
  inputMedia: ['image_url', 'image_data'],
});

/**
 * Groq: the OpenAI API shape at https://api.groq.com/openai/v1, on Groq's own
 * hardware. Usage in streams arrives in `x_groq.usage`; the model list reports
 * each model's context window and output limit. No embeddings.
 */
export const groqAdapter = createOpenAiStyleAdapter({
  kind: 'groq',
  displayName: 'Groq',
  description: 'Groq API (OpenAI-compatible): very fast inference for open models such as Llama, Qwen, Kimi and GPT-OSS.',
  defaultEndpoint: 'https://api.groq.com/openai/v1',
  apiKeyRequired: true,
  capabilities: ['CHAT', 'CODING', 'REASONING', 'VISION', 'TOOL_USE'],
  maxTokensField: 'max_completion_tokens',
  streamOptions: false,
  // Groq's vision models take images by URL or inline; no audio or files in chat.
  inputMedia: ['image_url', 'image_data'],
});

/**
 * OpenRouter: one OpenAI-style API in front of hundreds of models from many
 * providers, at https://openrouter.ai/api/v1. Its model list says, per model, the
 * context window, output limit, what goes in and out, whether it takes tools, the
 * APIs that serve it and an expiry date; every answer reports what it cost
 * (`usage.cost`), which ClawRouter records instead of its own estimate. Requests
 * name ClawRouter as the app (`HTTP-Referer`, `X-Title`). No embeddings.
 */
export const openRouterAdapter = createOpenAiStyleAdapter({
  kind: 'openrouter',
  displayName: 'OpenRouter',
  description: 'OpenRouter (OpenAI-compatible): hundreds of models from OpenAI, Anthropic, Google, Meta, Mistral and others behind one key, with free models marked ":free".',
  defaultEndpoint: 'https://openrouter.ai/api/v1',
  apiKeyRequired: true,
  capabilities: ['CHAT', 'CODING', 'REASONING', 'VISION', 'TOOL_USE'],
  maxTokensField: 'max_tokens',
  // Usage, cost included, comes in the last chunk without being asked.
  streamOptions: false,
  // Images by URL or inline; PDFs are read for any model (OpenRouter extracts the text when the model cannot).
  inputMedia: ['image_url', 'image_data', 'pdf'],
  extraHeaders: { 'HTTP-Referer': 'https://github.com/iant89/ClawRouter', 'X-Title': 'ClawRouter' },
  reportsCost: true,
});
