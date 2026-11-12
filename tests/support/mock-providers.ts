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
  stop(): Promise<void>;
}

const enc = new TextEncoder();
const sse = (events: { event?: string; data: unknown }[], delayMs = 0) =>
  new Response(
    new ReadableStream({
      async start(controller) {
        for (const e of events) {
          // Split each event across two chunks to exercise incremental parsing.
          const text = `${e.event ? `event: ${e.event}\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`;
          const mid = Math.floor(text.length / 2);
          controller.enqueue(enc.encode(text.slice(0, mid)));
          if (delayMs) await Bun.sleep(delayMs);
          controller.enqueue(enc.encode(text.slice(mid)));
        }
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );

export function startMockProviders(key = 'sk-test-0123456789abcdefWXYZ'): MockProviders {
  const state: MockProviders = { url: '', key, requests: [], mode: 'ok', slowMs: 0, stop: async () => {} };

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
      if (state.mode === 'rate_limited') return json({ error: { message: 'slow down' } }, 429);
      if (state.mode === 'garbage') return new Response('<html>not json</html>', { headers: { 'content-type': 'text/html' } });

      const [, family, ...rest] = url.pathname.split('/');
      const path = `/${rest.join('/')}`;
      const stream = typeof body === 'object' && body !== null && (body as { stream?: boolean }).stream === true;

      if (family === 'openai' || family === 'local') {
        // Error text echoes the key, as some providers do, to prove ClawAPI scrubs it.
        if (family === 'openai' && (state.mode === 'auth' || h.get('authorization') !== `Bearer ${key}`)) {
          return json({ error: { message: `Incorrect API key provided: ${h.get('authorization')?.slice(7) ?? ''}` } }, 401);
        }
        if (path === '/v1/models') return json({ object: 'list', data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }, { id: 'text-embedding-3-small' }] });
        if (path === '/v1/chat/completions') {
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

      if (family === 'anthropic') {
        if (state.mode === 'auth' || h.get('x-api-key') !== key) return json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401);
        if (h.get('anthropic-version') !== '2023-06-01') return json({ type: 'error', error: { message: 'missing version' } }, 400);
        if (path === '/v1/models') return json({ data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', type: 'model' }], has_more: false });
        if (path === '/v1/messages') {
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

      if (family === 'google') {
        if (url.searchParams.has('key')) return json({ error: { message: 'key must not be in the URL' } }, 400);
        if (state.mode === 'auth' || h.get('x-goog-api-key') !== key) return json({ error: { code: 403, message: 'API key not valid' } }, 403);
        if (path === '/v1beta/models') return json({ models: [{ name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' }] });
        if (path === '/v1beta/models/gemini-2.0-flash:generateContent') {
          return json({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hello ' }, { text: 'from Gemini' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 3, totalTokenCount: 9 }, modelVersion: 'gemini-2.0-flash-001' });
        }
        if (path === '/v1beta/models/gemini-2.0-flash:streamGenerateContent' && url.searchParams.get('alt') === 'sse') {
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
