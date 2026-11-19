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

/**
 * A local HTTP server imitating the OpenAI, Anthropic, Google (Gemini) and
 * OpenAI-compatible APIs closely enough to exercise the adapters end to end,
 * including SSE streaming. No real provider is ever called in tests.
 */
import type { Server } from 'bun';

export type MockMode = 'ok' | 'auth' | 'server_error' | 'rate_limited' | 'redirect' | 'slow' | 'garbage';

export interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockProviders {
  url: string;
  key: string;
  requests: RecordedRequest[];
  mode: MockMode;
  slowMs: number;
  /** Models the OpenAI-style mocks list; tests change it to simulate models appearing and disappearing. */
  openaiModels: string[];
  /** Provider families ("openai", "local", "anthropic", "google") that answer 500. */
  failFamilies: Set<string>;
  /** Families that answer 400 (the request is at fault). */
  badRequestFamilies: Set<string>;
  /** Streams break (connection error) after the first content event. */
  streamBreak: boolean;
  /** Delay between stream events (ms). */
  streamDelayMs: number;
  /** Stream events written so far (to see whether a cancelled stream really stopped). */
  streamEventsSent: number;
  /** Groq prices to publish instead of the built-in ones, by model id (US$ per token, as strings); null removes them. */
  groqPrices: Record<string, { prompt: string; completion: string } | null>;
  /** The attribution headers OpenRouter last received. */
  openRouterHeaders: { referer: string | null; title: string | null } | null;
  stop(): Promise<void>;
}

const enc = new TextEncoder();

export function startMockProviders(key = 'sk-test-0123456789abcdefWXYZ'): MockProviders {
  const state: MockProviders = {
    url: '', key, requests: [], mode: 'ok', slowMs: 0, openaiModels: ['gpt-4o-mini', 'gpt-4o', 'text-embedding-3-small'],
    failFamilies: new Set(), badRequestFamilies: new Set(), streamBreak: false, streamDelayMs: 0, streamEventsSent: 0, groqPrices: {}, openRouterHeaders: null, stop: async () => {},
  };

  const sse = (events: { event?: string; data: unknown }[]) =>
    new Response(
      new ReadableStream({
        async start(controller) {
          let content = 0;
          for (const e of events) {
            // Split each event across two chunks to exercise incremental parsing.
            const text = `${e.event ? `event: ${e.event}\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`;
            const mid = Math.floor(text.length / 2);
            try {
              controller.enqueue(enc.encode(text.slice(0, mid)));
              if (state.streamDelayMs) await Bun.sleep(state.streamDelayMs);
              controller.enqueue(enc.encode(text.slice(mid)));
            } catch {
              return; // the reader went away (cancelled)
            }
            state.streamEventsSent += 1;
            if (/"(content|text)":"[^"]+"|text_delta|"parts"/.test(text)) content += 1;
            if (state.streamBreak && content >= 1) {
              await Bun.sleep(30); // let the content reach the client first
              controller.error(new Error('connection reset'));
              return;
            }
          }
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );

  const server: Server<undefined> = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const raw = req.method === 'POST' ? await req.text() : '';
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      state.requests.push({ method: req.method, path: url.pathname, search: url.search, headers: Object.fromEntries(req.headers.entries()), body });
      const h = req.headers;
      const json = (data: unknown, status = 200) => Response.json(data, { status });

      if (state.mode === 'slow') await Bun.sleep(state.slowMs);
      if (state.mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'http://evil.example/steal' } });
      if (state.mode === 'server_error') return json({ error: { message: 'upstream exploded' } }, 500);
      if (state.mode === 'rate_limited') return Response.json({ error: { message: 'slow down' } }, { status: 429, headers: { 'retry-after': '7' } });
      if (state.mode === 'garbage') return new Response('<html>not json</html>', { headers: { 'content-type': 'text/html' } });

      const [, family, ...rest] = url.pathname.split('/');
      // Tools offered and no tool result in the conversation yet: answer with a call to the first tool (city: Paris).
      const b = (typeof body === 'object' && body !== null ? body : {}) as { tools?: { name?: string; function?: { name?: string }; functionDeclarations?: { name: string }[] }[]; messages?: { role?: string; content?: unknown }[]; contents?: { parts?: Record<string, unknown>[] }[] };
      const answered = JSON.stringify(b.messages ?? b.contents ?? []).match(/"role":"tool"|tool_result|functionResponse/) !== null;
      const toolName = b.tools?.[0]?.function?.name ?? b.tools?.[0]?.name ?? b.tools?.[0]?.functionDeclarations?.[0]?.name;
      const callTool = !!toolName && !answered;
      const path = `/${rest.join('/')}`;
      const stream = typeof body === 'object' && body !== null && (body as { stream?: boolean }).stream === true;
      if (rest.join('/').includes('models') && req.method === 'GET') {
        // model listing is unaffected by per-family failures (health checks stay green)
      } else if (state.failFamilies.has(family!)) {
        return json({ error: { message: `${family} is down` } }, 500);
      } else if (state.badRequestFamilies.has(family!)) {
        return json({ error: { message: 'This model maximum context length is 10 tokens' } }, 400);
      }

      if (family === 'openai' || family === 'local') {
        if (path === '/v1/embeddings' && (family === 'local' || h.get('authorization') === `Bearer ${key}`)) {
          const input = (body as { input: string[] }).input;
          return json({ object: 'list', model: 'text-embedding-3-small', data: input.map((_, i) => ({ object: 'embedding', index: i, embedding: [i, 0.5, -0.25] })).reverse(), usage: { prompt_tokens: 4 * input.length, total_tokens: 4 * input.length } });
        }
        // Error text echoes the key, as some providers do, to prove ClawRouter scrubs it.
        if (family === 'openai' && (state.mode === 'auth' || h.get('authorization') !== `Bearer ${key}`)) {
          return json({ error: { message: `Incorrect API key provided: ${h.get('authorization')?.slice(7) ?? ''}` } }, 401);
        }
        if (path === '/v1/models') return json({ object: 'list', data: state.openaiModels.map((id) => ({ id })) });
        // A DeepSeek-style reasoning model ("…-reasoner"): reasoning in `reasoning_content`, apart from the answer.
        if (path === '/v1/chat/completions' && String((body as { model?: unknown }).model ?? '').endsWith('-reasoner') && !callTool) {
          if (!stream) return json({ id: 'r1', model: 'deepseek-reasoner', choices: [{ index: 0, message: { role: 'assistant', content: 'Paris.', reasoning_content: 'The capital of France is Paris.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 } });
          return sse([
            { data: { model: 'deepseek-reasoner', choices: [{ delta: { role: 'assistant', content: null, reasoning_content: 'The capital ' } }] } },
            { data: { choices: [{ delta: { content: null, reasoning_content: 'is Paris.' } }] } },
            { data: { choices: [{ delta: { content: 'Paris.', reasoning_content: null }, finish_reason: 'stop' }] } },
            { data: { choices: [], usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 } } },
            { data: '[DONE]' },
          ]);
        }
        if (path === '/v1/chat/completions') {
          if (callTool && !stream) {
            return json({ id: 'c1', model: 'gpt-4o-mini-2024', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc', type: 'function', function: { name: toolName, arguments: '{"city":"Paris"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } });
          }
          if (callTool) {
            return sse([
              { data: { model: 'gpt-4o-mini-2024', choices: [{ delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: toolName, arguments: '' } }] } }] } },
              { data: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] } },
              { data: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] } }] } },
              { data: { choices: [{ delta: {}, finish_reason: 'tool_calls' }] } },
              { data: { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } } },
              { data: '[DONE]' },
            ]);
          }
          if (!stream) {
            return json({ id: 'c1', model: 'gpt-4o-mini-2024', choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from OpenAI' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } });
          }
          return sse([
            { data: { model: 'gpt-4o-mini-2024', choices: [{ delta: { role: 'assistant' } }] } },
            { data: { choices: [{ delta: { content: 'Hel' } }] } },
            { data: { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] } },
            { data: { choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } } },
            { data: '[DONE]' },
          ]);
        }
      }

      // Groq: the OpenAI shape under /openai/v1, usage in streams as `x_groq.usage`.
      if (family === 'groq') {
        if (state.mode === 'auth' || h.get('authorization') !== `Bearer ${key}`) {
          return json({ error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401);
        }
        if (path === '/openai/v1/models') {
          const priced = (m: Record<string, unknown>) => (m.id as string) in state.groqPrices
            ? { ...m, pricing: state.groqPrices[m.id as string] ?? undefined }
            : m;
          return json({ object: 'list', data: ([
            // Shaped like Groq's real list (2026-11): names, modalities, US$ prices per token.
            { id: 'llama-3.3-70b-versatile', object: 'model', owned_by: 'Meta', active: true, name: 'Llama 3.3 70B', context_window: 131072, max_completion_tokens: 32768, input_modalities: ['text'], output_modalities: ['text'], supported_features: ['tools', 'json_mode'], pricing: { prompt: '0.00000059', completion: '0.00000079' } },
            { id: 'openai/gpt-oss-120b', object: 'model', owned_by: 'OpenAI', active: true, name: 'GPT OSS 120B', context_window: 131072, max_completion_tokens: 65536, input_modalities: ['text'], output_modalities: ['text'], supported_features: ['tools', 'json_mode', 'reasoning'], pricing: { prompt: '0.00000015', completion: '0.0000006' } },
            { id: 'qwen/qwen3.8-27b', object: 'model', owned_by: 'Alibaba', active: true, name: 'Qwen 3.8 27B', context_window: 131072, max_completion_tokens: 16384, input_modalities: ['text', 'image'], output_modalities: ['text'], supported_features: ['json_mode'], pricing: { prompt: '0.0000008', completion: '0.000004' } },
            { id: 'whisper-large-v3', object: 'model', owned_by: 'OpenAI', active: true, name: 'Whisper', context_window: 448, input_modalities: ['audio'], output_modalities: ['transcription'] },
            { id: 'canopylabs/orpheus-v1-english', object: 'model', owned_by: 'Canopy Labs', active: true, name: 'Orpheus V1 English', context_window: 4000, max_completion_tokens: 50000, input_modalities: ['text'], output_modalities: ['speech'], pricing: { prompt: '0.000022' } },
            { id: 'meta-llama/llama-guard-4-12b', object: 'model', owned_by: 'Meta', active: true, context_window: 131072 },
            { id: 'mixtral-8x7b-32768', object: 'model', owned_by: 'Mistral AI', active: false, context_window: 32768 },
          ] as Record<string, unknown>[]).map(priced) });
        }
        if (path === '/openai/v1/chat/completions') {
          if (!stream) {
            return json({ id: 'chatcmpl-g1', object: 'chat.completion', model: 'llama-3.3-70b-versatile', choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from Groq' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, queue_time: 0.01, prompt_time: 0.002, completion_time: 0.01, total_time: 0.012 }, x_groq: { id: 'req_01' } });
          }
          return sse([
            { data: { id: 'chatcmpl-g2', model: 'llama-3.3-70b-versatile', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }], x_groq: { id: 'req_02' } } },
            { data: { id: 'chatcmpl-g2', choices: [{ index: 0, delta: { content: 'Hel' } }] } },
            { data: { id: 'chatcmpl-g2', choices: [{ index: 0, delta: { content: 'lo' } }] } },
            { data: { id: 'chatcmpl-g2', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], x_groq: { id: 'req_02', usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } } } },
            { data: '[DONE]' },
          ]);
        }
        return json({ error: { message: `Unknown request URL: ${path}`, type: 'invalid_request_error', code: 'unknown_url' } }, 404);
      }

      if (family === 'anthropic') {
        if (state.mode === 'auth' || h.get('x-api-key') !== key) return json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401);
        if (h.get('anthropic-version') !== '2023-06-01') return json({ type: 'error', error: { message: 'missing version' } }, 400);
        if (path === '/v1/models') return json({ data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', type: 'model' }], has_more: false });
        if (path === '/v1/messages') {
          if (callTool && !stream) {
            return json({ id: 'm2', type: 'message', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'toolu_01', name: toolName, input: { city: 'Paris' } }], stop_reason: 'tool_use', usage: { input_tokens: 30, output_tokens: 12 } });
          }
          if (callTool) {
            return sse([
              { event: 'message_start', data: { type: 'message_start', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 30, output_tokens: 1 } } } },
              { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
              { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check.' } } },
              { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
              { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01', name: toolName, input: {} } } },
              { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city": ' } } },
              { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Paris"}' } } },
              { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
              { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } } },
              { event: 'message_stop', data: { type: 'message_stop' } },
            ]);
          }
          // Extended thinking: a signed thinking block before the answer.
          if (String((body as { model?: unknown }).model ?? '').includes('thinking') && !callTool) {
            if (!stream) return json({ id: 'm3', type: 'message', model: 'claude-sonnet-4-5', content: [{ type: 'thinking', thinking: 'A greeting; answer briefly.', signature: 'c2ln' }, { type: 'text', text: 'Hello.' }], stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 20 } });
            return sse([
              { event: 'message_start', data: { type: 'message_start', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 9, output_tokens: 1 } } } },
              { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } },
              { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'A greeting; ' } } },
              { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'answer briefly.' } } },
              { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'c2ln' } } },
              { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
              { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
              { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello.' } } },
              { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
              { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } } },
              { event: 'message_stop', data: { type: 'message_stop' } },
            ]);
          }
          if (!stream) {
            return json({ id: 'm1', type: 'message', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'Hello from Anthropic' }], stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 5 } });
          }
          return sse([
            { event: 'message_start', data: { type: 'message_start', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 9, output_tokens: 1 } } } },
            { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
            { event: 'ping', data: { type: 'ping' } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi ' } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there' } } },
            { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
            { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 2 } } },
            { event: 'message_stop', data: { type: 'message_stop' } },
          ]);
        }
      }

      // OpenRouter: the OpenAI shape under /api/v1, a rich model list, and each answer's cost in usage.cost.
      if (family === 'openrouter') {
        if (state.mode === 'auth' || h.get('authorization') !== `Bearer ${key}`) return json({ error: { code: 401, message: 'No auth credentials found' } }, 401);
        state.openRouterHeaders = { referer: h.get('http-referer'), title: h.get('x-title') };
        if (path === '/api/v1/models') {
          const chat = ['/api/v1/chat/completions', '/api/v1/completions', '/api/v1/messages', '/api/v1/responses'];
          // Shaped like OpenRouter's real list (2026-11-19).
          return json({ data: [
            { id: 'anthropic/claude-haiku-5.5', name: 'Anthropic: Claude Haiku 5.5', context_length: 1000000, architecture: { modality: 'text+image+file->text', input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] }, pricing: { prompt: '0.0000001', completion: '0.0000005' }, top_provider: { context_length: 1000000, max_completion_tokens: 128000 }, supported_parameters: ['max_tokens', 'temperature', 'tools', 'tool_choice'], endpoints: chat, expiration_date: null },
            { id: 'anthropic/claude-haiku-5.5:batch', name: 'Anthropic: Claude Haiku 5.5 (batch)', context_length: 1000000, architecture: { input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] }, pricing: { prompt: '0.00000005', completion: '0.00000025' }, top_provider: { context_length: 1000000, max_completion_tokens: 128000 }, supported_parameters: ['max_tokens', 'tools'], endpoints: ['/api/v1/batches'] },
            { id: 'nvidia/nemotron-3.5-lightning:free', name: 'NVIDIA: Nemotron 3.5 Lightning (free)', context_length: 1000000, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' }, top_provider: { context_length: 1000000, max_completion_tokens: 65536 }, supported_parameters: ['max_tokens', 'reasoning', 'tools', 'tool_choice'], endpoints: chat },
            { id: 'acme/plain-chat', name: 'Acme: Plain Chat', context_length: 32768, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0.000001', completion: '0.000002' }, top_provider: { context_length: 32768, max_completion_tokens: null }, supported_parameters: ['max_tokens', 'temperature'], endpoints: chat },
            { id: 'google/gemini-3.1-flash-image', name: 'Google: Gemini 3.1 Flash Image', context_length: 65536, architecture: { input_modalities: ['image', 'text'], output_modalities: ['image', 'text'] }, pricing: { prompt: '0.0000005', completion: '0.000003' }, top_provider: { context_length: 65536, max_completion_tokens: 32768 }, supported_parameters: ['max_tokens'], endpoints: [...chat, '/api/v1/images'] },
            { id: 'thinkingmachines/inkling-2-small:free', name: 'Thinking Machines: Inkling 2 Small (free)', context_length: 131072, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' }, top_provider: { context_length: 131072, max_completion_tokens: 8192 }, supported_parameters: ['max_tokens'], endpoints: chat, expiration_date: '2026-11-18' },
          ] });
        }
        if (path === '/api/v1/chat/completions') {
          // OpenRouter's charge differs from list price × tokens (e.g. the provider it routed to); free models cost 0.
          const free = String((body as { model?: unknown }).model ?? '').endsWith(':free');
          const usage = { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, cost: free ? 0 : 0.0000041, is_byok: false, completion_tokens_details: { reasoning_tokens: 2 } };
          if (callTool && !stream) {
            return json({ id: 'gen-1', provider: 'Anthropic', model: 'anthropic/claude-haiku-5.5', choices: [{ index: 0, message: { role: 'assistant', content: null, reasoning: null, tool_calls: [{ id: 'toolu_or1', type: 'function', function: { name: toolName, arguments: '{"city":"Paris"}' } }] }, finish_reason: 'tool_calls' }], usage });
          }
          if (!stream) {
            // Reasoning comes in its own field and must never become the answer.
            return json({ id: 'gen-1', provider: 'Anthropic', model: 'anthropic/claude-haiku-5.5', choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from OpenRouter', reasoning: 'The user greets me.', refusal: null }, finish_reason: 'stop', native_finish_reason: 'end_turn' }], usage });
          }
          return sse([
            { data: { id: 'gen-2', provider: 'Anthropic', model: 'anthropic/claude-haiku-5.5', choices: [{ index: 0, delta: { role: 'assistant', content: '', reasoning: 'Thinking.' } }] } },
            { data: { id: 'gen-2', choices: [{ index: 0, delta: { content: 'Hi ' } }] } },
            { data: { id: 'gen-2', choices: [{ index: 0, delta: { content: 'there' }, finish_reason: 'stop' }] } },
            { data: { id: 'gen-2', choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }], usage: { ...usage, completion_tokens: 2, total_tokens: 14, cost: free ? 0 : 0.0000029 } } },
            { data: '[DONE]' },
          ]);
        }
      }

      if (family === 'google') {
        if (url.searchParams.has('key')) return json({ error: { message: 'key must not be in the URL' } }, 400);
        if (state.mode === 'auth' || h.get('x-goog-api-key') !== key) return json({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }, 400);
        if (path === '/v1beta/models') {
          // Two pages, like Google's list once it is long: a thinking model and a speech model on the second.
          if (url.searchParams.get('pageToken') === 'page-2') {
            return json({
              models: [
                { name: 'models/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'countTokens'], thinking: true },
                { name: 'models/gemini-2.5-flash-preview-tts', displayName: 'Gemini 2.5 Flash Preview TTS', inputTokenLimit: 8192, outputTokenLimit: 16384, supportedGenerationMethods: ['countTokens', 'generateContent'] },
                // Seen in Google's real list (2026-11-19): music, images and an Interactions-only agent, all with generateContent.
                { name: 'models/lyria-3.5', displayName: 'Lyria 3.5', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/gemini-nano-banana-2.1', displayName: 'Nano Banana 2.1', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/antigravity-preview-latest', displayName: 'Antigravity Preview', supportedGenerationMethods: ['generateContent'] },
              ],
            });
          }
          return json({
            models: [
              { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', inputTokenLimit: 1048576, outputTokenLimit: 8192, supportedGenerationMethods: ['generateContent', 'countTokens'] },
              { name: 'models/text-embedding-004', displayName: 'Text Embedding 004', inputTokenLimit: 2048, outputTokenLimit: 1, supportedGenerationMethods: ['embedContent'] },
            ],
            nextPageToken: 'page-2',
          });
        }
        // A thinking model: a thought summary part, then the answer; reasoning tokens counted apart.
        if (path === '/v1beta/models/gemini-3.5-flash:generateContent') {
          return json({ candidates: [{ content: { role: 'model', parts: [{ text: 'The user greets me; answer politely.', thought: true }, { text: 'Hello from thinking Gemini', thoughtSignature: 'dGhvdWdodA==' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 5, thoughtsTokenCount: 40, totalTokenCount: 51 }, modelVersion: 'gemini-3.5-flash' });
        }
        if (path === '/v1beta/models/gemini-3.5-flash:streamGenerateContent' && url.searchParams.get('alt') === 'sse') {
          return sse([
            { data: { candidates: [{ content: { parts: [{ text: 'Thinking about it.', thought: true }] } }] } },
            { data: { candidates: [{ content: { parts: [{ text: 'Thought ' }] } }] } },
            { data: { candidates: [{ content: { parts: [{ text: 'through' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2, thoughtsTokenCount: 30, totalTokenCount: 38 }, modelVersion: 'gemini-3.5-flash' } },
          ]);
        }
        if (path === '/v1beta/models/text-embedding-004:batchEmbedContents') {
          const requests = (body as { requests: unknown[] }).requests;
          return json({ embeddings: requests.map((_, i) => ({ values: [i, 1, 2] })) });
        }
        if (path === '/v1beta/models/gemini-2.0-flash:generateContent') {
          if (callTool) {
            return json({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: toolName, args: { city: 'Paris' } }, thoughtSignature: 'c2lnbmF0dXJlLTE=' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 6, totalTokenCount: 31 }, modelVersion: 'gemini-2.0-flash-001' });
          }
          return json({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hello ' }, { text: 'from Gemini' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 3, totalTokenCount: 9 }, modelVersion: 'gemini-2.0-flash-001' });
        }
        if (path === '/v1beta/models/gemini-2.0-flash:streamGenerateContent' && url.searchParams.get('alt') === 'sse') {
          if (callTool) {
            return sse([
              { data: { candidates: [{ content: { parts: [{ functionCall: { name: toolName, args: { city: 'Paris' } }, thoughtSignature: 'c2lnbmF0dXJlLTE=' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 6, totalTokenCount: 31 }, modelVersion: 'gemini-2.0-flash-001' } },
            ]);
          }
          return sse([
            { data: { candidates: [{ content: { parts: [{ text: 'Gem' }] } }] } },
            { data: { candidates: [{ content: { parts: [{ text: 'ini' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2, totalTokenCount: 8 }, modelVersion: 'gemini-2.0-flash-001' } },
          ]);
        }
      }
      return json({ error: { message: `no mock for ${req.method} ${url.pathname}` } }, 404);
    },
  });
  state.url = `http://127.0.0.1:${server.port}`;
  state.stop = () => server.stop(true);
  return state;
}
