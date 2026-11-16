import type { ProviderKindInfo } from '@clawrouter/shared';
import { invalidResponse, joinUrl, ProviderCallError, providerFetch, readJson } from '../http.ts';
import { parseSse } from '../sse.ts';
import type { ChatMessage, ChatRequest, MessagePart, ToolChoice, ChatResponse, FinishReason, ProviderAdapter, ProviderCallContext, StreamEvent, Usage } from '../types.ts';
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
  // Images by URL or inline, PDFs inline (as a document block). No audio.
  inputMedia: ['image_url', 'image_data', 'pdf'],
};

const headers = (ctx: ProviderCallContext): Record<string, string> => ({
  'content-type': 'application/json',
  accept: 'application/json',
  'anthropic-version': API_VERSION,
  ...(ctx.apiKey ? { 'x-api-key': ctx.apiKey } : {}),
});

/** A message part as an Anthropic content block. Audio never reaches here (not in inputMedia). */
function anthropicBlock(p: MessagePart): Record<string, unknown> {
  switch (p.type) {
    case 'text': return { type: 'text', text: p.text };
    case 'image': return { type: 'image', source: p.source.kind === 'url' ? { type: 'url', url: p.source.url } : { type: 'base64', media_type: p.source.mediaType, data: p.source.data } };
    case 'pdf': return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.data }, ...(p.filename ? { title: p.filename } : {}) };
    case 'audio': throw new Error('Anthropic does not accept audio');
  }
}

/** JSON arguments as an object (Anthropic wants `input` as an object, not text). */
function parseArguments(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text || '{}');
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { arguments: text };
  }
}

/**
 * Messages as Anthropic content blocks. Tool calls become `tool_use` blocks in the
 * assistant turn; tool results become `tool_result` blocks in a user turn, and
 * results that follow each other share one turn, as Anthropic requires.
 */
function anthropicMessages(messages: ChatMessage[]): { role: 'user' | 'assistant'; content: unknown }[] {
  const out: { role: 'user' | 'assistant'; content: unknown }[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
      const last = out.at(-1);
      if (last?.role === 'user' && Array.isArray(last.content) && (last.content as { type?: string }[]).every((b) => b.type === 'tool_result')) {
        (last.content as unknown[]).push(block);
      } else out.push({ role: 'user', content: [block] });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: parseArguments(c.arguments) })),
        ],
      });
      continue;
    }
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.parts ? m.parts.map(anthropicBlock) : m.content });
  }
  return out;
}

function anthropicToolChoice(choice: ToolChoice | undefined, parallel: boolean | undefined): Record<string, unknown> {
  const noParallel = parallel === false ? { disable_parallel_tool_use: true } : {};
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any', ...noParallel };
  if (typeof choice === 'object') return { type: 'tool', name: choice.name, ...noParallel };
  return { type: 'auto', ...noParallel };
}

function body(req: ChatRequest, stream: boolean) {
  const { system, rest } = splitSystem(req.messages);
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages: anthropicMessages(rest),
    ...(req.tools?.length ? { tools: req.tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), input_schema: t.parameters ?? { type: 'object', properties: {} } })) } : {}),
    ...(req.tools?.length && (req.toolChoice !== undefined || req.parallelToolCalls === false) ? { tool_choice: anthropicToolChoice(req.toolChoice, req.parallelToolCalls) } : {}),
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
    const json = await readJson<{ model?: string; content?: { type?: string; text?: string; id?: string; name?: string; input?: unknown }[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } }>(res, ctx.apiKey);
    if (!Array.isArray(json.content)) throw invalidResponse('no content in response');
    const text = json.content.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
    const toolCalls = json.content.filter((b) => b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string')
      .map((b) => ({ id: b.id!, name: b.name!, arguments: JSON.stringify(b.input ?? {}) }));
    return {
      model: json.model ?? req.model, content: text, finishReason: finish(json.stop_reason), usage: usage(json.usage?.input_tokens ?? null, json.usage?.output_tokens ?? null),
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  },

  async *sendStreamingRequest(ctx, req): AsyncGenerator<StreamEvent> {
    const res = await providerFetch(ctx, joinUrl(ctx.endpoint, '/v1/messages'), {
      method: 'POST', headers: { ...headers(ctx), accept: 'text/event-stream' }, body: JSON.stringify(body(req, true)),
    });
    if (!res.body) throw invalidResponse('empty stream');
    let model = req.model;
    let input: number | null = null;
    let output: number | null = null;
    // Content block index -> tool call index (tool calls are numbered from 0 in the order they start).
    const toolIndex = new Map<number, number>();
    let reason: FinishReason = 'other';
    for await (const event of parseSse(res.body, ctx.signal)) {
      let data: {
        type?: string;
        index?: number;
        content_block?: { type?: string; id?: string; name?: string };
        message?: { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
        delta?: { type?: string; text?: string; stop_reason?: string; partial_json?: string };
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
        case 'content_block_start':
          if (data.content_block?.type === 'tool_use' && typeof data.index === 'number') {
            const i = toolIndex.size;
            toolIndex.set(data.index, i);
            yield { type: 'tool_call', index: i, id: data.content_block.id ?? `call_${i}`, name: data.content_block.name ?? '' };
          }
          break;
        case 'content_block_delta':
          if (data.delta?.type === 'text_delta' && data.delta.text) yield { type: 'delta', text: data.delta.text };
          if (data.delta?.type === 'input_json_delta' && data.delta.partial_json && typeof data.index === 'number' && toolIndex.has(data.index)) {
            yield { type: 'tool_call', index: toolIndex.get(data.index)!, arguments: data.delta.partial_json };
          }
          break;
        case 'message_delta':
          if (data.delta?.stop_reason) reason = finish(data.delta.stop_reason);
          output = data.usage?.output_tokens ?? output;
          input = data.usage?.input_tokens ?? input;
          break;
        case 'error':
          throw new ProviderCallError('server_error', `The provider reported a stream error: ${(data.error?.message ?? 'unknown').slice(0, 200)}`);
        default:
          break; // ping, content_block_stop, message_stop
      }
      if (data.type === 'message_stop') break;
    }
    yield { type: 'done', finishReason: reason, usage: usage(input, output), model };
  },
};
