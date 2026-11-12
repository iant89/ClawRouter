import { AppError, type EventBus, type Logger } from '@clawrouter/core';
import type { ModelService } from '@clawrouter/models';
import { ProviderCallError, type ProviderService, type StreamEvent } from '@clawrouter/providers';
import type { Admission, RateLimitService } from '@clawrouter/rate-limits';
import type { RequestHandle, RequestLogService } from '@clawrouter/requests';
import type { RoutingService } from '@clawrouter/routing';
import type { Capability, GatewayEndpoint, RequestAttempt, RouteCandidate, RoutePlan, UsageSource } from '@clawrouter/shared';
import { modelAllowed, type ApiKeyPrincipal } from './api-keys.ts';
import { cancelled, ModelsRateLimitedError, runAttempts, type AttemptOutcome } from './executor.ts';
import { GatewayMetricsRecorder } from './metrics.ts';
import { finishReason, invalid, parseChatRequest, parseEmbeddingRequest, sse, unixTime, usageBlock } from './openai.ts';

export interface GatewayRequestContext {
  requestId: string;
  /** Aborted when the client disconnects. */
  signal: AbortSignal;
}

export type GatewayResult =
  | { kind: 'json'; status: number; body: unknown; headers: Record<string, string> }
  | { kind: 'stream'; stream: ReadableStream<Uint8Array>; headers: Record<string, string> };

export type GatewayService = ReturnType<typeof createGatewayService>;

interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  source: UsageSource;
}

/** Rough local token count (about four characters per token), used only when the provider reports none. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

/** Fills in token counts the provider did not report with a local estimate (spec §23). */
function withEstimate(reported: Usage, inputChars: number, outputChars: number): Usage {
  const input = reported.inputTokens ?? estimateTokens(inputChars);
  const output = reported.outputTokens ?? estimateTokens(outputChars);
  const estimated = reported.inputTokens === null || reported.outputTokens === null;
  return { inputTokens: input, outputTokens: output, source: estimated ? 'estimated' : 'provider' };
}

/**
 * The request gateway (spec §6): authenticate (done by the HTTP layer), authorize
 * the model, validate and normalize, route, execute with retry and failover,
 * stream, then report the outcome. Clients never learn which provider handled
 * the request unless they read the informational X-ClawRouter-* headers.
 */
export function createGatewayService(options: {
  routing: RoutingService;
  providers: ProviderService;
  models: ModelService;
  events?: EventBus;
  log?: Logger;
  /** Rate limits (phase 9). Without it nothing is limited (unit tests). */
  limits?: RateLimitService;
  /** Request history and usage (phase 10). Without it nothing is recorded. */
  requests?: RequestLogService;
  metrics?: GatewayMetricsRecorder;
  now?: () => Date;
  backoffMs?: number;
}) {
  const { routing, providers, models, events, log, limits, requests } = options;
  const now = options.now ?? (() => new Date());
  const metrics = options.metrics ?? new GatewayMetricsRecorder(() => now().getTime(), () => limits?.rejections() ?? { lastMinute: 0, total: 0 });
  const encoder = new TextEncoder();
  const unlimited: Admission = { headers: {}, charge: async () => {}, release: async () => {} };
  const checkModel = limits ? (c: RouteCandidate) => limits.useModel(c.modelRef) : undefined;
  const noRecord: RequestHandle = { streaming: () => {}, finish: () => {} };

  /** Route, translating "nothing to route to" into client-facing errors. */
  function plan(key: ApiKeyPrincipal, model: string, capability: Capability): RoutePlan {
    if (!modelAllowed(key, model)) throw new AppError('AUTHORIZATION_ERROR', `This API key is not allowed to use the model '${model}'.`, { details: { param: 'model' } });
    try {
      return routing.plan({ model, capabilities: [capability] });
    } catch (error) {
      if (error instanceof AppError && error.code === 'ROUTING_ERROR') {
        if (error.message.startsWith('Unknown model')) throw new AppError('NOT_FOUND', `The model '${model}' does not exist.`, { details: { param: 'model', code: 'model_not_found' } });
        throw new AppError('SERVICE_UNAVAILABLE', `No model is available for '${model}' right now.`, { expose: true, details: { param: 'model' } });
      }
      throw error;
    }
  }

  const routeHeaders = (o: Pick<AttemptOutcome<unknown>, 'candidate' | 'attempts'>) => ({
    'x-clawrouter-model': o.candidate.modelRef,
    'x-clawrouter-attempts': String(o.attempts),
  });

  /**
   * One gateway request from authentication to its end: the history record,
   * rate-limit admission and charging, metrics and events. Every request ends
   * through exactly one `succeed` or `fail`, so all of them agree.
   */
  function startRun(key: ApiKeyPrincipal, endpoint: GatewayEndpoint, body: unknown, ctx: GatewayRequestContext) {
    const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const requestedModel = typeof raw.model === 'string' ? raw.model.slice(0, 300) : '';
    const stream = endpoint === 'chat.completions' && raw.stream === true;
    const record = requests?.begin({ id: ctx.requestId, endpoint, stream, apiKeyId: key.id, userId: key.ownerId, requestedModel }) ?? noRecord;
    const t0 = performance.now();
    const trace: RequestAttempt[] = [];
    let admission = unlimited;
    let started = false;
    let ended = false;
    const elapsed = () => Math.round(performance.now() - t0);

    /** Attempts and model switches as the trace saw them (models skipped for their rate limit are not attempts). */
    const counts = () => {
      const made = trace.filter((t) => t.outcome !== 'skipped_rate_limit');
      const models = new Set(made.map((t) => t.modelRef));
      const last = made.at(-1) ?? trace.at(-1) ?? null;
      return { attempts: made.length, failovers: Math.max(0, models.size - 1), retries: made.length - models.size, last };
    };

    return {
      trace,
      get admission() {
        return admission;
      },

      /** Rate limits; a refused request never counts as started. */
      async admit() {
        if (limits) admission = await limits.admit({ keyId: key.id, ownerId: key.ownerId, keyLimit: key.rateLimit }, ctx.requestId);
        started = true;
        metrics.started();
        events?.emit('request.started', { requestId: ctx.requestId, apiKeyId: key.id, model: requestedModel, stream });
      },

      streaming: () => record.streaming(),

      succeed(o: AttemptOutcome<unknown>, usage: Usage) {
        if (ended) return;
        ended = true;
        void admission.release();
        const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        // Token limits are charged after the fact, with the real (or estimated) usage.
        void admission.charge(tokens).catch((error: unknown) => log?.error('rate-limit charge failed', { component: 'gateway', error }));
        if (limits) void limits.chargeModel(o.candidate.modelRef, tokens).catch((error: unknown) => log?.error('rate-limit charge failed', { component: 'gateway', error }));
        const durationMs = elapsed();
        const c = counts();
        metrics.finished({ ok: true, latencyMs: durationMs, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, retries: c.retries, failovers: c.failovers });
        events?.emit('request.completed', {
          requestId: ctx.requestId, apiKeyId: key.id, model: requestedModel, modelRef: o.candidate.modelRef, providerId: o.candidate.providerId, stream,
          durationMs, attempts: c.attempts, failovers: c.failovers, usage,
        });
        record.finish({
          status: 'COMPLETED', httpStatus: 200, durationMs, modelRef: o.candidate.modelRef, providerId: o.candidate.providerId,
          attempts: c.attempts, retries: c.retries, failovers: c.failovers, attemptLog: trace, errorCode: null, errorMessage: null, usage,
        });
      },

      /** Records a failure and returns the error to throw (rate-limit exhaustion becomes a 429). */
      fail(caught: unknown, override?: { status: 'FAILED' | 'CANCELLED'; httpStatus: number; code: string; message: string }): unknown {
        let error = caught;
        if (caught instanceof ModelsRateLimitedError && limits) {
          error = limits.modelsExhausted(caught.modelRef, caught.denial.retryAfterMs, caught.denial.kind, caught.denial.limit, ctx.requestId);
        }
        if (ended) return error;
        ended = true;
        void admission.release();
        const isCancel = (error instanceof ProviderCallError && error.failure === 'cancelled') || ctx.signal.aborted;
        const e = error instanceof AppError ? error : null;
        const outcome = override ?? (isCancel
          ? { status: 'CANCELLED' as const, httpStatus: 499, code: 'CANCELLED', message: 'The client disconnected.' }
          : { status: e?.code === 'PROVIDER_TIMEOUT' ? 'TIMEOUT' as const : 'FAILED' as const, httpStatus: e?.status ?? 500, code: e?.code ?? 'INTERNAL_ERROR', message: e?.publicMessage ?? 'An internal error occurred.' });
        const durationMs = elapsed();
        const c = counts();
        if (started) {
          metrics.finished({ ok: false, latencyMs: durationMs });
          events?.emit('request.failed', {
            requestId: ctx.requestId, apiKeyId: key.id, model: requestedModel, stream, durationMs, attempts: c.attempts, code: outcome.code, status: outcome.httpStatus,
          });
        }
        record.finish({
          status: outcome.status, httpStatus: outcome.httpStatus, durationMs, modelRef: c.last?.modelRef ?? null, providerId: c.last?.providerId ?? null,
          attempts: c.attempts, retries: c.retries, failovers: c.failovers, attemptLog: trace, errorCode: outcome.code, errorMessage: outcome.message,
          usage: { inputTokens: null, outputTokens: null, source: 'none' },
        });
        return error;
      },
    };
  }

  /** Runs `body` as one recorded request: any error is recorded, then rethrown. */
  async function recorded(run: ReturnType<typeof startRun>, body: () => Promise<GatewayResult>): Promise<GatewayResult> {
    try {
      const result = await body();
      result.headers = { ...run.admission.headers, ...result.headers };
      return result;
    } catch (error) {
      throw run.fail(error);
    }
  }

  return {
    metrics,

    /** GET /v1/models: enabled aliases and usable models, limited to what the key may use. */
    listModels(key: ApiKeyPrincipal) {
      const config = routing.get();
      const created = unixTime(now());
      const aliases = config.aliases.filter((a) => a.enabled).map((a) => ({ id: a.name, object: 'model', created: config.updatedAt ? unixTime(new Date(config.updatedAt)) : created, owned_by: 'clawrouter' }));
      const refs = models.listUsable().map((m) => ({ id: m.ref, object: 'model', created: unixTime(new Date(m.createdAt)), owned_by: m.provider.identifier }));
      return { object: 'list', data: [...aliases, ...refs].filter((m) => modelAllowed(key, m.id)) };
    },

    /** POST /v1/chat/completions */
    async chat(key: ApiKeyPrincipal, body: unknown, ctx: GatewayRequestContext): Promise<GatewayResult> {
      const run = startRun(key, 'chat.completions', body, ctx);
      return recorded(run, async () => {
        const req = parseChatRequest(body);
        const route = plan(key, req.model, 'CHAT');
        await run.admit();
        const id = `chatcmpl-${ctx.requestId.replace(/^req_/, '')}`;
        const created = unixTime(now());
        const promptChars = req.messages.reduce((n, m) => n + m.content.length, 0);
        const chatRequest = (c: RouteCandidate) => ({
          model: c.providerModelId, messages: req.messages, maxTokens: req.maxTokens, temperature: req.temperature, topP: req.topP, stop: req.stop,
        });

        if (!req.stream) {
          const o = await runAttempts(route, {
            signal: ctx.signal, failures: routing.failures, log, backoffMs: options.backoffMs, checkModel, trace: run.trace,
            call: (c, signal) => providers.chat(c.providerId, chatRequest(c), signal),
          });
          run.succeed(o, withEstimate(o.value.usage, promptChars, o.value.content.length));
          const usage = usageBlock(o.value.usage);
          return {
            kind: 'json', status: 200, headers: routeHeaders(o),
            body: {
              id, object: 'chat.completion', created, model: o.candidate.modelRef,
              choices: [{ index: 0, message: { role: 'assistant', content: o.value.content }, finish_reason: finishReason(o.value.finishReason), logprobs: null }],
              ...(usage ? { usage } : {}),
            },
          };
        }

        // Streaming. Failover is possible until the first event arrives; after that
        // the response is committed and a failure ends the stream with an error event.
        const abort = new AbortController();
        const onClientGone = () => abort.abort();
        ctx.signal.addEventListener('abort', onClientGone, { once: true });
        let o: AttemptOutcome<{ it: AsyncIterator<StreamEvent>; first: IteratorResult<StreamEvent> }>;
        try {
          o = await runAttempts(route, {
            signal: abort.signal, failures: routing.failures, log, backoffMs: options.backoffMs, checkModel, trace: run.trace,
            call: async (c, signal) => {
              const it = providers.chatStream(c.providerId, chatRequest(c), signal)[Symbol.asyncIterator]();
              const first = await it.next();
              return { it, first };
            },
          });
        } catch (error) {
          ctx.signal.removeEventListener('abort', onClientGone);
          throw error;
        }
        run.streaming();
        const model = o.candidate.modelRef;
        const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
          id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
        });
        let outputChars = 0;
        let done = false;
        const finishStream = (outcome: { ok: true; usage: Usage } | { ok: false }) => {
          if (done) return;
          done = true;
          ctx.signal.removeEventListener('abort', onClientGone);
          if (outcome.ok) run.succeed(o, withEstimate(outcome.usage, promptChars, outputChars));
          else if (abort.signal.aborted) run.fail(cancelled());
          else run.fail(null, { status: 'FAILED', httpStatus: 200, code: 'STREAM_INTERRUPTED', message: 'The model provider failed while streaming the response.' });
        };

        let pending: IteratorResult<StreamEvent> | null = o.value.first;
        let sentRole = false;
        const stream = new ReadableStream<Uint8Array>({
          // pull() is called only when the client is ready for more: nothing is buffered beyond one event.
          async pull(controller) {
            try {
              if (!sentRole) {
                sentRole = true;
                controller.enqueue(encoder.encode(sse(chunk({ role: 'assistant', content: '' }, null))));
                return;
              }
              const next = pending ?? (await o.value.it.next());
              pending = null;
              if (abort.signal.aborted) throw cancelled();
              if (next.done) {
                // A stream that ends without a final event: close it cleanly anyway.
                controller.enqueue(encoder.encode(sse('[DONE]')));
                controller.close();
                finishStream({ ok: true, usage: { inputTokens: null, outputTokens: null, source: 'none' } });
                return;
              }
              const event = next.value;
              if (event.type === 'delta') {
                outputChars += event.text.length;
                controller.enqueue(encoder.encode(sse(chunk({ content: event.text }, null))));
                return;
              }
              controller.enqueue(encoder.encode(sse(chunk({}, finishReason(event.finishReason)))));
              const usage = usageBlock(event.usage);
              if (req.includeUsage) controller.enqueue(encoder.encode(sse({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usage ?? null })));
              controller.enqueue(encoder.encode(sse('[DONE]')));
              controller.close();
              finishStream({ ok: true, usage: event.usage });
            } catch (error) {
              if (!abort.signal.aborted) routing.failures.recordFailure(o.candidate.providerId);
              log?.info('stream ended with an error', { component: 'gateway', model, error: error instanceof Error ? error.message : String(error) });
              try {
                controller.enqueue(encoder.encode(sse({ error: { message: 'The model provider failed while streaming the response.', type: 'api_error', code: 'stream_interrupted', param: null } })));
                controller.close();
              } catch {
                // the client is already gone
              }
              finishStream({ ok: false });
            }
          },
          async cancel() {
            // The client disconnected: stop the provider call too (spec §13).
            abort.abort();
            await o.value.it.return?.(undefined).catch(() => {});
            finishStream({ ok: false });
          },
        });
        return {
          kind: 'stream',
          stream,
          headers: { ...routeHeaders(o), 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' },
        };
      });
    },

    /** POST /v1/embeddings */
    async embeddings(key: ApiKeyPrincipal, body: unknown, ctx: GatewayRequestContext): Promise<GatewayResult> {
      const run = startRun(key, 'embeddings', body, ctx);
      return recorded(run, async () => {
        const req = parseEmbeddingRequest(body);
        const route = plan(key, req.model, 'EMBEDDINGS');
        await run.admit();
        const o = await runAttempts(route, {
          signal: ctx.signal, failures: routing.failures, log, backoffMs: options.backoffMs, checkModel, trace: run.trace,
          call: (c, signal) => providers.embed(c.providerId, { model: c.providerModelId, input: req.input }, signal),
        });
        const inputChars = req.input.reduce((n, s) => n + s.length, 0);
        run.succeed(o, withEstimate({ inputTokens: o.value.usage.inputTokens, outputTokens: 0, source: o.value.usage.source }, inputChars, 0));
        const prompt = o.value.usage.inputTokens;
        return {
          kind: 'json', status: 200, headers: routeHeaders(o),
          body: {
            object: 'list', model: o.candidate.modelRef,
            data: o.value.embeddings.map((embedding, index) => ({ object: 'embedding', index, embedding })),
            ...(prompt !== null ? { usage: { prompt_tokens: prompt, total_tokens: prompt } } : {}),
          },
        };
      });
    },

    /** POST /v1/responses: not offered yet; a clear error instead of a generic 404. */
    responses(): never {
      throw invalid("The Responses API is not supported yet. Use /v1/chat/completions.");
    },
  };
}
