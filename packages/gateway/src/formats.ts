import type { ChatResponse, FinishReason, Usage } from '@clawrouter/providers';
import { assistantMessage, finishReason, sse, toolCallDelta, usageBlock } from './openai.ts';

/** A piece of a streamed tool call (see `StreamEvent` in the providers package). */
export interface ToolCallPiece {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

/**
 * How a chat result is written for one public API. The pipeline (routing,
 * failover, limits, recording) is the same for every API; only this differs.
 * Streaming methods return the server-sent events to send, already serialized.
 */
export interface ChatFormatter {
  /** The whole answer (not streamed). */
  complete(r: ChatResponse, model: string): unknown;
  /** Before the first piece of a stream. */
  start(model: string): string[];
  text(delta: string): string[];
  toolCall(piece: ToolCallPiece): string[];
  /** The provider finished. Includes whatever ends the stream. */
  finish(reason: FinishReason, usage: Usage): string[];
  /** The provider stopped without saying how: end the stream cleanly anyway. */
  end(): string[];
  /** The provider failed after the stream started. */
  error(): string[];
}

/** POST /v1/chat/completions: the OpenAI Chat Completions format. */
export function chatCompletionsFormat(o: { id: string; created: number; includeUsage: boolean }): ChatFormatter {
  let model = '';
  const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
    id: o.id, object: 'chat.completion.chunk', created: o.created, model, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
  });
  return {
    complete(r, m) {
      const usage = usageBlock(r.usage);
      return {
        id: o.id, object: 'chat.completion', created: o.created, model: m,
        choices: [{ index: 0, message: assistantMessage(r), finish_reason: finishReason(r.finishReason), logprobs: null }],
        ...(usage ? { usage } : {}),
      };
    },
    start(m) {
      model = m;
      return [sse(chunk({ role: 'assistant', content: '' }, null))];
    },
    text: (delta) => [sse(chunk({ content: delta }, null))],
    toolCall: (piece) => [sse(chunk({ tool_calls: [toolCallDelta(piece)] }, null))],
    finish(reason, usage) {
      const block = usageBlock(usage);
      return [
        sse(chunk({}, finishReason(reason))),
        ...(o.includeUsage ? [sse({ id: o.id, object: 'chat.completion.chunk', created: o.created, model, choices: [], usage: block ?? null })] : []),
        sse('[DONE]'),
      ];
    },
    end: () => [sse('[DONE]')],
    error: () => [sse({ error: { message: 'The model provider failed while streaming the response.', type: 'api_error', code: 'stream_interrupted', param: null } })],
  };
}
