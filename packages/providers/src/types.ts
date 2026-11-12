import type { Capability, FieldIssue, ProviderKind, ProviderKindInfo } from '@clawapi/shared';

/**
 * Normalized request/response types: what the gateway (phase 8) speaks.
 * Provider-specific formats stay inside the adapters (spec §7).
 */
export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
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
}

export type { ProviderKind };
