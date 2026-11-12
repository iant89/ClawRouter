import { AppError } from '@clawrouter/core';
import type { ChatMessage, FinishReason, Usage } from '@clawrouter/providers';

/**
 * The external API speaks the OpenAI wire format (spec §7): requests are parsed
 * and validated here and responses built here. Provider formats never reach clients.
 */

/** A client error in the request, pointing at the offending parameter (OpenAI `param`). */
export function invalid(message: string, param: string | null = null): AppError {
  return new AppError('VALIDATION_ERROR', message, { details: { param, issues: param ? [{ path: param, message }] : [] } });
}

export interface ParsedChatRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  stream: boolean;
  includeUsage: boolean;
}

export interface ParsedEmbeddingRequest {
  model: string;
  input: string[];
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function num(body: Record<string, unknown>, key: string, min: number, max: number, integer = false): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
    throw invalid(`'${key}' must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}.`, key);
  }
  return v;
}

function model(body: Record<string, unknown>): string {
  if (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 300) throw invalid("'model' is required: an alias, a model reference or a model id.", 'model');
  return body.model.trim();
}

/** Text from an OpenAI content value: a string, or an array of text parts. */
function text(content: unknown, param: string): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part, i) => {
        if (!isObject(part)) throw invalid('Content parts must be objects.', `${param}[${i}]`);
        if (part.type === 'text' && typeof part.text === 'string') return part.text;
        if (part.type === 'image_url' || part.type === 'input_audio' || part.type === 'file') {
          throw invalid(`Content of type '${String(part.type)}' is not supported yet; send text only.`, `${param}[${i}]`);
        }
        throw invalid(`Unknown content part type '${String(part.type)}'.`, `${param}[${i}]`);
      })
      .join('');
  }
  if (content === null || content === undefined) return '';
  throw invalid('Message content must be a string or an array of text parts.', param);
}

/** Parses POST /v1/chat/completions. Unsupported features fail clearly instead of being ignored. */
export function parseChatRequest(body: unknown): ParsedChatRequest {
  if (!isObject(body)) throw invalid('The request body must be a JSON object.');
  const m = model(body);
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw invalid("'messages' must be a non-empty array.", 'messages');
  if (body.messages.length > 10_000) throw invalid("'messages' has too many entries.", 'messages');
  for (const key of ['tools', 'functions', 'tool_choice', 'function_call'] as const) {
    if (body[key] !== undefined && body[key] !== null) throw invalid(`'${key}' is not supported yet.`, key);
  }
  if (body.n !== undefined && body.n !== null && body.n !== 1) throw invalid("Only 'n': 1 is supported.", 'n');
  const format = body.response_format;
  if (isObject(format) && format.type !== 'text') throw invalid(`'response_format' type '${String(format.type)}' is not supported yet.`, 'response_format');

  const messages: ChatMessage[] = body.messages.map((raw, i) => {
    const param = `messages[${i}]`;
    if (!isObject(raw)) throw invalid('Each message must be an object.', param);
    const role = raw.role === 'developer' ? 'system' : raw.role;
    if (role === 'tool' || role === 'function' || raw.tool_calls) throw invalid('Tool messages are not supported yet.', `${param}.role`);
    if (role !== 'system' && role !== 'user' && role !== 'assistant') throw invalid("Role must be 'system', 'developer', 'user' or 'assistant'.", `${param}.role`);
    return { role, content: text(raw.content, `${param}.content`) };
  });
  if (!messages.some((m2) => m2.role === 'user')) throw invalid('At least one user message is required.', 'messages');

  let stop: string[] | undefined;
  if (typeof body.stop === 'string') stop = [body.stop];
  else if (Array.isArray(body.stop)) {
    if (body.stop.length > 4 || !body.stop.every((s) => typeof s === 'string')) throw invalid("'stop' must be a string or up to 4 strings.", 'stop');
    stop = body.stop as string[];
  } else if (body.stop !== undefined && body.stop !== null) throw invalid("'stop' must be a string or up to 4 strings.", 'stop');

  if (body.stream !== undefined && body.stream !== null && typeof body.stream !== 'boolean') throw invalid("'stream' must be a boolean.", 'stream');
  const stream = body.stream === true;
  const streamOptions = isObject(body.stream_options) ? body.stream_options : {};

  return {
    model: m,
    messages,
    maxTokens: num(body, 'max_completion_tokens', 1, 1_000_000, true) ?? num(body, 'max_tokens', 1, 1_000_000, true),
    temperature: num(body, 'temperature', 0, 2),
    topP: num(body, 'top_p', 0, 1),
    stop,
    stream,
    includeUsage: stream && streamOptions.include_usage === true,
  };
}

/** Parses POST /v1/embeddings. */
export function parseEmbeddingRequest(body: unknown): ParsedEmbeddingRequest {
  if (!isObject(body)) throw invalid('The request body must be a JSON object.');
  const m = model(body);
  const input = typeof body.input === 'string' ? [body.input] : body.input;
  if (!Array.isArray(input) || input.length === 0 || input.length > 2048 || !input.every((s) => typeof s === 'string' && s.length > 0)) {
    throw invalid("'input' must be a non-empty string or an array of up to 2048 non-empty strings.", 'input');
  }
  if (body.encoding_format !== undefined && body.encoding_format !== 'float') throw invalid("Only 'encoding_format': 'float' is supported.", 'encoding_format');
  if (body.dimensions !== undefined) throw invalid("'dimensions' is not supported yet.", 'dimensions');
  return { model: m, input: input as string[] };
}

export const finishReason = (r: FinishReason): string =>
  r === 'length' ? 'length' : r === 'content_filter' ? 'content_filter' : r === 'tool_use' ? 'tool_calls' : 'stop';

export function usageBlock(u: Usage): { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined {
  if (u.source !== 'provider' || u.inputTokens === null) return undefined;
  const completion = u.outputTokens ?? 0;
  return { prompt_tokens: u.inputTokens, completion_tokens: completion, total_tokens: u.totalTokens ?? u.inputTokens + completion };
}

export const unixTime = (d: Date) => Math.floor(d.getTime() / 1000);

/** Serializes one SSE event. */
export const sse = (data: unknown) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
