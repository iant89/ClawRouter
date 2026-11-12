import type { ProviderKindInfo } from '@clawapi/shared';
import { invalidResponse, joinUrl, ProviderCallError, providerFetch, readJson } from '../http.ts';
import { parseSse } from '../sse.ts';
import type { ChatRequest, ChatResponse, FinishReason, ProviderAdapter, ProviderCallContext, StreamEvent, Usage } from '../types.ts';
import { baseValidation, connectionChecks, splitSystem } from './common.ts';

const API_VERSION = '2023-06-01';
/** The Messages API requires max_tokens; used when the client sets none. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

const finish = (reason: string | null | undefined): FinishReason =>
  reason === 'end_turn' || reason === 'stop_sequence' ? 'stop' : reason === 'max_tokens' ? 'length' : reason === 'tool_use' ? 'tool_use' : reason === 'refusal' ? 'content_filter' : 'other';

const usage = (input: number | null, output: number | null): Usage => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input !== null && output !== null ? input + output : null,
  source: input !== null || output !== null ? 'provider' : 'none',
});

const info: ProviderKindInfo = {
  kind: 'anthropic',
  displayName: 'Anthropic',
  description: 'Anthropic Messages API (Claude models).',
  defaultEndpoint: 'https://api.anthropic.com',
  endpointRequired: false,
  apiKeyRequired: true,
  capabilities: ['CHAT', 'CODING', 'REASONING', 'VISION', 'TOOL_USE'],
  supportsStreaming: true,
};

const headers = (ctx: ProviderCallContext): Record<string, string> => ({
  'content-type': 'application/json',
  accept: 'application/json',
  'anthropic-version': API_VERSION,
  ...(ctx.apiKey ? { 'x-api-key': ctx.apiKey } : {}),
});

function body(req: ChatRequest, stream: boolean) {
  const { system, rest } = splitSystem(req.messages);
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages: rest.map((m) => ({ role: m.role, content: m.content })),
    ...(system ? { system } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    ...(req.stop?.length ? { stop_sequences: req.stop } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

async function listModels(ctx: ProviderCallContext) {
  const res = await providerFetch(ctx, joinUrl(ctx.endpoint, '/v1/models?limit=100'), { method: 'GET', headers: headers(ctx) });
  const json = await readJson<{ data?: { id?: unknown; display_name?: unknown }[] }>(res, ctx.apiKey);
  if (!Array.isArray(json.data)) throw invalidResponse('model list has no "data" array');
  return json.data
    .filter((m): m is { id: string; display_name?: unknown } => typeof m.id === 'string')
    .map((m) => ({ id: m.id, displayName: typeof m.display_name === 'string' ? m.display_name : null, kind: 'chat' as const }));
}

export const anthropicAdapter: ProviderAdapter = {
  info,
  capabilities: info.capabilities,
  validateConfiguration: (config) => baseValidation(config, true),
  listModels,
  ...connectionChecks(listModels),

  async sendRequest(ctx, req): Promise<ChatResponse> {
    const res = await providerFetch(ctx, joinUrl(ctx.endpoint, '/v1/messages'), { method: 'POST', headers: headers(ctx), body: JSON.stringify(body(req, false)) });
    const json = await readJson<{ model?: string; content?: { type?: string; text?: string }[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } }>(res, ctx.apiKey);
    if (!Array.isArray(json.content)) throw invalidResponse('no content in response');
    const text = json.content.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
    return { model: json.model ?? req.model, content: text, finishReason: finish(json.stop_reason), usage: usage(json.usage?.input_tokens ?? null, json.usage?.output_tokens ?? null) };
  },

  async *sendStreamingRequest(ctx, req): AsyncGenerator<StreamEvent> {
    const res = await providerFetch(ctx, joinUrl(ctx.endpoint, '/v1/messages'), {
      method: 'POST', headers: { ...headers(ctx), accept: 'text/event-stream' }, body: JSON.stringify(body(req, true)),
    });
    if (!res.body) throw invalidResponse('empty stream');
    let model = req.model;
    let input: number | null = null;
    let output: number | null = null;
    let reason: FinishReason = 'other';
    for await (const event of parseSse(res.body, ctx.signal)) {
      let data: {
        type?: string;
        message?: { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
        delta?: { type?: string; text?: string; stop_reason?: string };
        usage?: { output_tokens?: number; input_tokens?: number };
        error?: { message?: string };
      };
      try {
        data = JSON.parse(event.data);
      } catch {
        throw invalidResponse('malformed stream event');
      }
      switch (data.type) {
        case 'message_start':
          model = data.message?.model ?? model;
          input = data.message?.usage?.input_tokens ?? input;
          output = data.message?.usage?.output_tokens ?? output;
          break;
        case 'content_block_delta':
          if (data.delta?.type === 'text_delta' && data.delta.text) yield { type: 'delta', text: data.delta.text };
          break;
        case 'message_delta':
          if (data.delta?.stop_reason) reason = finish(data.delta.stop_reason);
          output = data.usage?.output_tokens ?? output;
          input = data.usage?.input_tokens ?? input;
          break;
        case 'error':
          throw new ProviderCallError('server_error', `The provider reported a stream error: ${(data.error?.message ?? 'unknown').slice(0, 200)}`);
        default:
          break; // ping, content_block_start/stop, message_stop
      }
      if (data.type === 'message_stop') break;
    }
    yield { type: 'done', finishReason: reason, usage: usage(input, output), model };
  },
};
