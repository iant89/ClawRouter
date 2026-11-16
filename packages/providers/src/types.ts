import type { Capability, FieldIssue, MediaKind, ProviderKind, ProviderKindInfo } from '@clawrouter/shared';

/**
 * Normalized request/response types: what the gateway (phase 8) speaks.
 * Provider-specific formats stay inside the adapters (spec §7).
 */
export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  /** The message's text (all text parts joined). Always set, also when `parts` is. */
  content: string;
  /**
   * Text and media in order, when the message carries media (user messages only).
   * Absent for plain text: adapters then send `content` as before.
   */
  parts?: MessagePart[];
}

/** One piece of a message with media. Inline data is base64 without a `data:` prefix. */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { kind: 'url'; url: string } | { kind: 'data'; mediaType: string; data: string }; detail?: 'auto' | 'low' | 'high' }
  | { type: 'audio'; format: 'wav' | 'mp3'; data: string }
  | { type: 'pdf'; filename: string | null; data: string };

/** The media kinds a message list needs from a provider. */
export function mediaOf(messages: ChatMessage[]): Set<MediaKind> {
  const kinds = new Set<MediaKind>();
  for (const m of messages) {
    for (const p of m.parts ?? []) {
      if (p.type === 'image') kinds.add(p.source.kind === 'url' ? 'image_url' : 'image_data');
      else if (p.type === 'audio') kinds.add('audio');
      else if (p.type === 'pdf') kinds.add('pdf');
    }
  }
  return kinds;
}

export interface ChatRequest {
  /** The provider's own model id (e.g. "gpt-4o-mini", "claude-sonnet-4-5"). */
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
}

export type FinishReason = 'stop' | 'length' | 'content_filter' | 'tool_use' | 'other';

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** Spec §23: provider-reported vs locally estimated. Adapters only report what the provider sent. */
  source: 'provider' | 'none';
}

export interface ChatResponse {
  model: string;
  content: string;
  finishReason: FinishReason;
  usage: Usage;
}

/** Normalized stream events (spec §13). */
export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; finishReason: FinishReason; usage: Usage; model: string };

export interface DiscoveredModel {
  id: string;
  displayName: string | null;
  /** Input token limit, when the provider publishes it (Google does). */
  contextLength?: number | null;
  maxOutputTokens?: number | null;
  /** Best guess from the provider's metadata or the model id. */
  kind?: 'chat' | 'embedding' | 'other';
  /** Accepts images, when the provider says so (Groq: `input_modalities`). */
  vision?: boolean;
  /** Prices in US$ per million tokens, when the provider publishes them (Groq: `pricing`). */
  cost?: { inputPerMTok: number | null; outputPerMTok: number | null } | null;
}

/** Everything an adapter needs for one call. The API key is decrypted just for the call. */
export interface ProviderCallContext {
  endpoint: string;
  apiKey: string | null;
  timeoutMs: number;
  /** Cancels the call (client disconnect, gateway timeout). */
  signal?: AbortSignal;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

/**
 * A provider implementation (spec §8). Answers "how do I talk to this
 * provider?" and nothing else: no routing policy, no persistence.
 */
export interface ProviderAdapter {
  readonly info: ProviderKindInfo;
  readonly capabilities: readonly Capability[];
  validateConfiguration(config: { endpoint: string; apiKey: string | null }): FieldIssue[];
  /** Lists models; used by testConnection and (phase 6) model discovery. */
  listModels(ctx: ProviderCallContext): Promise<DiscoveredModel[]>;
  testConnection(ctx: ProviderCallContext): Promise<{ latencyMs: number; models: DiscoveredModel[] }>;
  healthCheck(ctx: ProviderCallContext): Promise<{ latencyMs: number }>;
  sendRequest(ctx: ProviderCallContext, request: ChatRequest): Promise<ChatResponse>;
  sendStreamingRequest(ctx: ProviderCallContext, request: ChatRequest): AsyncIterable<StreamEvent>;
  /** Text embeddings. Absent when the provider has no embeddings API (Anthropic). */
  embed?(ctx: ProviderCallContext, request: EmbeddingRequest): Promise<EmbeddingResponse>;
}

export type { ProviderKind };

export interface EmbeddingRequest {
  model: string;
  input: string[];
}

export interface EmbeddingResponse {
  model: string;
  /** One vector per input, in input order. */
  embeddings: number[][];
  usage: Usage;
}
