import type { ProviderKindInfo } from '@clawapi/shared';
import { invalidResponse, joinUrl, providerFetch, readJson } from '../http.ts';
import { parseSse } from '../sse.ts';
import type { ChatRequest, ChatResponse, FinishReason, ProviderAdapter, ProviderCallContext, StreamEvent, Usage } from '../types.ts';
import { baseValidation, connectionChecks, guessKind, splitSystem } from './common.ts';

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: GeminiUsage;
  modelVersion?: string;
}

const finish = (reason: string | undefined): FinishReason =>
  reason === 'STOP' ? 'stop' : reason === 'MAX_TOKENS' ? 'length' : reason === 'SAFETY' || reason === 'RECITATION' || reason === 'BLOCKLIST' || reason === 'PROHIBITED_CONTENT' ? 'content_filter' : 'other';

const usageOf = (u: GeminiUsage | undefined): Usage =>
  u ? { inputTokens: u.promptTokenCount ?? null, outputTokens: u.candidatesTokenCount ?? null, totalTokens: u.totalTokenCount ?? null, source: 'provider' }
    : { inputTokens: null, outputTokens: null, totalTokens: null, source: 'none' };

const info: ProviderKindInfo = {
  kind: 'google',
  displayName: 'Google',
  description: 'Google Gemini API (Generative Language API).',
  defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta',
  endpointRequired: false,
  apiKeyRequired: true,
  capabilities: ['CHAT', 'CODING', 'REASONING', 'VISION', 'EMBEDDINGS', 'TOOL_USE'],
  supportsStreaming: true,
};

/** The key goes in a header, never in the URL (spec §29). */
const headers = (ctx: ProviderCallContext): Record<string, string> => ({
  'content-type': 'application/json',
  accept: 'application/json',
  ...(ctx.apiKey ? { 'x-goog-api-key': ctx.apiKey } : {}),
});

const modelPath = (model: string) => `/models/${encodeURIComponent(model.replace(/^models\//, ''))}`;

function body(req: ChatRequest) {
  const { system, rest } = splitSystem(req.messages);
  const generationConfig = {
    ...(req.maxTokens !== undefined ? { maxOutputTokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { topP: req.topP } : {}),
    ...(req.stop?.length ? { stopSequences: req.stop } : {}),
  };
  return {
    contents: rest.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
  };
}

const textOf = (r: GeminiResponse) => (r.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');

async function listModels(ctx: ProviderCallContext) {
  const res = await providerFetch(ctx, joinUrl(ctx.endpoint, '/models?pageSize=100'), { method: 'GET', headers: headers(ctx) });
  type GoogleModel = { name: string; displayName?: unknown; inputTokenLimit?: unknown; outputTokenLimit?: unknown; supportedGenerationMethods?: unknown };
  const json = await readJson<{ models?: Partial<GoogleModel>[] }>(res, ctx.apiKey);
  if (!Array.isArray(json.models)) throw invalidResponse('model list has no "models" array');
  const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);
  return json.models
    .filter((m): m is GoogleModel => typeof m.name === 'string')
    .map((m) => {
      const methods = Array.isArray(m.supportedGenerationMethods) ? (m.supportedGenerationMethods as unknown[]) : [];
      const kind = methods.includes('generateContent') ? 'chat' as const : methods.includes('embedContent') ? 'embedding' as const : methods.length ? 'other' as const : guessKind(m.name);
      return {
        id: m.name.replace(/^models\//, ''),
        displayName: typeof m.displayName === 'string' ? m.displayName : null,
        contextLength: num(m.inputTokenLimit),
        maxOutputTokens: num(m.outputTokenLimit),
        kind,
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
    const json = await readJson<GeminiResponse>(res, ctx.apiKey);
    if (!Array.isArray(json.candidates)) throw invalidResponse('no candidates in response');
    return { model: json.modelVersion ?? req.model, content: textOf(json), finishReason: finish(json.candidates[0]?.finishReason), usage: usageOf(json.usageMetadata) };
  },

  async *sendStreamingRequest(ctx, req): AsyncGenerator<StreamEvent> {
    const res = await providerFetch(ctx, joinUrl(ctx.endpoint, `${modelPath(req.model)}:streamGenerateContent?alt=sse`), {
      method: 'POST', headers: { ...headers(ctx), accept: 'text/event-stream' }, body: JSON.stringify(body(req)),
    });
    if (!res.body) throw invalidResponse('empty stream');
    let reason: FinishReason = 'other';
    let usage: Usage = usageOf(undefined);
    let model = req.model;
    for await (const event of parseSse(res.body, ctx.signal)) {
      let chunk: GeminiResponse;
      try {
        chunk = JSON.parse(event.data);
      } catch {
        throw invalidResponse('malformed stream chunk');
      }
      const text = textOf(chunk);
      if (text) yield { type: 'delta', text };
      if (chunk.candidates?.[0]?.finishReason) reason = finish(chunk.candidates[0].finishReason);
      if (chunk.usageMetadata) usage = usageOf(chunk.usageMetadata);
      if (chunk.modelVersion) model = chunk.modelVersion;
    }
    yield { type: 'done', finishReason: reason, usage, model };
  },
};
