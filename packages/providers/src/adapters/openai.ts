import type { Capability, ProviderKind, ProviderKindInfo } from '@clawapi/shared';
import { invalidResponse, joinUrl, providerFetch, readJson } from '../http.ts';
import { parseSse } from '../sse.ts';
import type { ChatRequest, ChatResponse, FinishReason, ProviderAdapter, ProviderCallContext, StreamEvent, Usage } from '../types.ts';
import { baseValidation, connectionChecks, guessKind } from './common.ts';

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

const finish = (reason: string | null | undefined): FinishReason =>
  reason === 'stop' ? 'stop' : reason === 'length' ? 'length' : reason === 'content_filter' ? 'content_filter' : reason === 'tool_calls' || reason === 'function_call' ? 'tool_use' : 'other';

const usageOf = (u: OpenAiUsage | undefined | null): Usage =>
  u ? { inputTokens: u.prompt_tokens ?? null, outputTokens: u.completion_tokens ?? null, totalTokens: u.total_tokens ?? null, source: 'provider' }
    : { inputTokens: null, outputTokens: null, totalTokens: null, source: 'none' };

export interface OpenAiStyleOptions {
  kind: Extract<ProviderKind, 'openai' | 'openai_compatible'>;
  displayName: string;
  description: string;
  defaultEndpoint: string | null;
  apiKeyRequired: boolean;
  capabilities: Capability[];
  /** OpenAI's own API: `max_completion_tokens` and streamed usage. Compatible servers get the classic fields. */
  official: boolean;
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
  };

  const headers = (ctx: ProviderCallContext): Record<string, string> => ({
    'content-type': 'application/json',
    accept: 'application/json',
    ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {}),
  });

  const body = (req: ChatRequest, stream: boolean) => ({
    model: req.model,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    ...(req.maxTokens !== undefined ? { [options.official ? 'max_completion_tokens' : 'max_tokens']: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    ...(req.stop?.length ? { stop: req.stop } : {}),
    stream,
    ...(stream && options.official ? { stream_options: { include_usage: true } } : {}),
  });

  async function listModels(ctx: ProviderCallContext) {
    const res = await providerFetch(ctx, joinUrl(ctx.endpoint, '/models'), { method: 'GET', headers: headers(ctx) });
    const json = await readJson<{ data?: { id?: unknown }[] }>(res, ctx.apiKey);
    if (!Array.isArray(json.data)) throw invalidResponse('model list has no "data" array');
    return json.data.filter((m): m is { id: string } => typeof m.id === 'string').map((m) => ({ id: m.id, displayName: null, kind: guessKind(m.id) }));
  }

  return {
    info,
    capabilities: options.capabilities,
    validateConfiguration: (config) => baseValidation(config, options.apiKeyRequired),
    listModels,
    ...connectionChecks(listModels),

    async sendRequest(ctx, req): Promise<ChatResponse> {
      const res = await providerFetch(ctx, joinUrl(ctx.endpoint, '/chat/completions'), { method: 'POST', headers: headers(ctx), body: JSON.stringify(body(req, false)) });
      const json = await readJson<{ model?: string; choices?: { message?: { content?: string | null }; finish_reason?: string }[]; usage?: OpenAiUsage }>(res, ctx.apiKey);
      const choice = json.choices?.[0];
      if (!choice) throw invalidResponse('no choices in response');
      return { model: json.model ?? req.model, content: choice.message?.content ?? '', finishReason: finish(choice.finish_reason), usage: usageOf(json.usage) };
    },

    async *sendStreamingRequest(ctx, req): AsyncGenerator<StreamEvent> {
      const res = await providerFetch(ctx, joinUrl(ctx.endpoint, '/chat/completions'), {
        method: 'POST', headers: { ...headers(ctx), accept: 'text/event-stream' }, body: JSON.stringify(body(req, true)),
      });
      if (!res.body) throw invalidResponse('empty stream');
      let reason: FinishReason = 'other';
      let usage: Usage = usageOf(null);
      let model = req.model;
      for await (const event of parseSse(res.body, ctx.signal)) {
        if (event.data === '[DONE]') break;
        let chunk: { model?: string; choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[]; usage?: OpenAiUsage | null };
        try {
          chunk = JSON.parse(event.data);
        } catch {
          throw invalidResponse('malformed stream chunk');
        }
        if (chunk.model) model = chunk.model;
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) yield { type: 'delta', text: choice.delta.content };
        if (choice?.finish_reason) reason = finish(choice.finish_reason);
        if (chunk.usage) usage = usageOf(chunk.usage);
      }
      yield { type: 'done', finishReason: reason, usage, model };
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
  official: true,
});

export const openAiCompatibleAdapter = createOpenAiStyleAdapter({
  kind: 'openai_compatible',
  displayName: 'Local / OpenAI-compatible',
  description: 'Any server implementing the OpenAI Chat Completions API: Ollama, vLLM, LM Studio, llama.cpp, LiteLLM and others. The API key is optional.',
  defaultEndpoint: null,
  apiKeyRequired: false,
  capabilities: ['CHAT', 'CODING', 'EMBEDDINGS'],
  official: false,
});
