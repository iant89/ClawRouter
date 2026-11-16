import type { ProviderKindInfo } from '@clawrouter/shared';
import { invalidResponse, joinUrl, providerFetch, readJson } from '../http.ts';
import { parseSse } from '../sse.ts';
import type { ChatMessage, ChatRequest, MessagePart, ToolCall, ToolChoice, ChatResponse, EmbeddingResponse, FinishReason, ProviderAdapter, ProviderCallContext, StreamEvent, Usage } from '../types.ts';
import { baseValidation, connectionChecks, guessKind, splitSystem } from './common.ts';

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: unknown; id?: string };
  /** Gemini 3: must be sent back with the function call on the next turn. */
  thoughtSignature?: string;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
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

function body(req: ChatRequest) {
  const { system, rest } = splitSystem(req.messages);
  const generationConfig = {
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
    const toolCalls = toolCallsOf(json);
    return {
      model: json.modelVersion ?? req.model, content: textOf(json), usage: usageOf(json.usageMetadata),
      // Gemini says STOP after a function call; clients expect tool_calls.
      finishReason: toolCalls.length ? 'tool_use' : finish(json.candidates[0]?.finishReason),
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  },

  async embed(ctx, req): Promise<EmbeddingResponse> {
    const name = `models/${req.model.replace(/^models\//, '')}`;
    const res = await providerFetch(ctx, joinUrl(ctx.endpoint, `${modelPath(req.model)}:batchEmbedContents`), {
      method: 'POST', headers: headers(ctx),
      body: JSON.stringify({ requests: req.input.map((text) => ({ model: name, content: { parts: [{ text }] } })) }),
    });
    const json = await readJson<{ embeddings?: { values?: unknown }[] }>(res, ctx.apiKey);
    if (!Array.isArray(json.embeddings) || json.embeddings.length !== req.input.length || !json.embeddings.every((e) => Array.isArray(e.values))) {
      throw invalidResponse('embeddings do not match the inputs');
    }
    // The Gemini API reports no token usage for embeddings.
    return { model: req.model, embeddings: json.embeddings.map((e) => e.values as number[]), usage: usageOf(undefined) };
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
      let chunk: GeminiResponse;
      try {
        chunk = JSON.parse(event.data);
      } catch {
        throw invalidResponse('malformed stream chunk');
      }
      const text = textOf(chunk);
      if (text) yield { type: 'delta', text };
      // Gemini sends each function call whole, in one chunk.
      for (const call of toolCallsOf(chunk)) yield { type: 'tool_call', index: calls++, id: call.id, name: call.name, arguments: call.arguments };
      if (chunk.candidates?.[0]?.finishReason) reason = finish(chunk.candidates[0].finishReason);
      if (chunk.usageMetadata) usage = usageOf(chunk.usageMetadata);
      if (chunk.modelVersion) model = chunk.modelVersion;
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
  return (r.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => typeof p.functionCall?.name === 'string')
    .map((p) => ({ id: callId(p.thoughtSignature), name: p.functionCall!.name!, arguments: JSON.stringify(p.functionCall!.args ?? {}) }));
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
