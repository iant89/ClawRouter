import { AppError, type EventBus, type Logger } from '@clawrouter/core';
import type { ModelService } from '@clawrouter/models';
import type { ProviderService, StreamEvent } from '@clawrouter/providers';
import type { RoutingService } from '@clawrouter/routing';
import type { Capability, RouteCandidate, RoutePlan } from '@clawrouter/shared';
import { modelAllowed, type ApiKeyPrincipal } from './api-keys.ts';
import type { Admission, RateLimitService } from '@clawrouter/rate-limits';
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
  metrics?: GatewayMetricsRecorder;
  now?: () => Date;
  backoffMs?: number;
}) {
  const { routing, providers, models, events, log, limits } = options;
  const now = options.now ?? (() => new Date());
  const metrics = options.metrics ?? new GatewayMetricsRecorder(() => now().getTime(), () => limits?.rejections() ?? { lastMinute: 0, total: 0 });
  const encoder = new TextEncoder();
  const unlimited: Admission = { headers: {}, charge: async () => {}, release: async () => {} };
  const checkModel = limits ? (c: RouteCandidate) => limits.useModel(c.modelRef) : undefined;

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
   * Common bookkeeping around one gateway request: rate-limit admission (a refused
   * request never starts), events, metrics, and the x-ratelimit-* headers. A JSON
   * result releases its concurrency slot here; a stream releases it when it ends.
   */
  async function track(key: ApiKeyPrincipal, model: string, stream: boolean, ctx: GatewayRequestContext, run: (admission: Admission) => Promise<GatewayResult>): Promise<GatewayResult> {
    const admission = limits ? await limits.admit({ keyId: key.id, ownerId: key.ownerId, keyLimit: key.rateLimit }, ctx.requestId) : unlimited;
    metrics.started();
    events?.emit('request.started', { requestId: ctx.requestId, apiKeyId: key.id, model, stream });
    const started = performance.now();
    try {
      const result = await run(admission);
      result.headers = { ...admission.headers, ...result.headers };
      if (result.kind === 'json') await admission.release();
      return result;
    } catch (caught) {
      await admission.release();
      let error = caught;
      if (caught instanceof ModelsRateLimitedError && limits) {
        error = limits.modelsExhausted(caught.modelRef, caught.denial.retryAfterMs, caught.denial.kind, caught.denial.limit, ctx.requestId);
      }
      const e = error instanceof AppError ? error : null;
      const durationMs = Math.round(performance.now() - started);
      metrics.finished({ ok: false, latencyMs: durationMs });
      events?.emit('request.failed', {
        requestId: ctx.requestId, apiKeyId: key.id, model, stream, durationMs,
        attempts: Number((e?.details as { attempts?: number } | undefined)?.attempts ?? 0), code: e?.code ?? 'INTERNAL_ERROR', status: e?.status ?? 500,
      });
      throw error;
    }
  }

  function completed(key: ApiKeyPrincipal, model: string, stream: boolean, ctx: GatewayRequestContext, o: AttemptOutcome<unknown>, startedAt: number,
    usage: { inputTokens: number | null; outputTokens: number | null; source: 'provider' | 'none' }, admission: Admission) {
    const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    // Token limits are charged after the fact, with what the provider reported.
    void admission.charge(tokens).catch((error: unknown) => log?.error('rate-limit charge failed', { component: 'gateway', error }));
    if (limits) void limits.chargeModel(o.candidate.modelRef, tokens).catch((error: unknown) => log?.error('rate-limit charge failed', { component: 'gateway', error }));
    const durationMs = Math.round(performance.now() - startedAt);
    metrics.finished({ ok: true, latencyMs: durationMs, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, retries: o.retries, failovers: o.failovers });
    events?.emit('request.completed', {
      requestId: ctx.requestId, apiKeyId: key.id, model, modelRef: o.candidate.modelRef, providerId: o.candidate.providerId, stream,
      durationMs, attempts: o.attempts, failovers: o.failovers, usage,
    });
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
      const req = parseChatRequest(body);
      const route = plan(key, req.model, 'CHAT');
      const id = `chatcmpl-${ctx.requestId.replace(/^req_/, '')}`;
      const created = unixTime(now());
      const chatRequest = (c: RouteCandidate) => ({
        model: c.providerModelId, messages: req.messages, maxTokens: req.maxTokens, temperature: req.temperature, topP: req.topP, stop: req.stop,
      });

      if (!req.stream) {
        return track(key, req.model, false, ctx, async (admission) => {
          const startedAt = performance.now();
          const o = await runAttempts(route, {
            signal: ctx.signal, failures: routing.failures, log, backoffMs: options.backoffMs, checkModel,
            call: (c, signal) => providers.chat(c.providerId, chatRequest(c), signal),
          });
          completed(key, req.model, false, ctx, o, startedAt, o.value.usage, admission);
          const usage = usageBlock(o.value.usage);
          return {
            kind: 'json', status: 200, headers: routeHeaders(o),
            body: {
              id, object: 'chat.completion', created, model: o.candidate.modelRef,
              choices: [{ index: 0, message: { role: 'assistant', content: o.value.content }, finish_reason: finishReason(o.value.finishReason), logprobs: null }],
              ...(usage ? { usage } : {}),
            },
          };
        });
      }

      // Streaming. Failover is possible until the first event arrives; after that
      // the response is committed and a failure ends the stream with an error event.
      const abort = new AbortController();
      const onClientGone = () => abort.abort();
      ctx.signal.addEventListener('abort', onClientGone, { once: true });
      return track(key, req.model, true, ctx, async (admission) => {
        const startedAt = performance.now();
        const o = await runAttempts(route, {
          signal: abort.signal, failures: routing.failures, log, backoffMs: options.backoffMs, checkModel,
          call: async (c, signal) => {
            const it = providers.chatStream(c.providerId, chatRequest(c), signal)[Symbol.asyncIterator]();
            const first = await it.next();
            return { it, first };
          },
        });
        const model = o.candidate.modelRef;
        const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
          id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
        });
        let done = false;
        const finishStream = (ok: boolean, usage?: { inputTokens: number | null; outputTokens: number | null; source: 'provider' | 'none' }) => {
          if (done) return;
          done = true;
          ctx.signal.removeEventListener('abort', onClientGone);
          void admission.release();
          if (ok && usage) completed(key, req.model, true, ctx, o, startedAt, usage, admission);
          else {
            const durationMs = Math.round(performance.now() - startedAt);
            metrics.finished({ ok: false, latencyMs: durationMs });
            events?.emit('request.failed', { requestId: ctx.requestId, apiKeyId: key.id, model: req.model, stream: true, durationMs, attempts: o.attempts, code: abort.signal.aborted ? 'CANCELLED' : 'PROVIDER_ERROR', status: abort.signal.aborted ? 499 : 502 });
          }
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
                finishStream(true, { inputTokens: null, outputTokens: null, source: 'none' });
                return;
              }
              const event = next.value;
              if (event.type === 'delta') {
                controller.enqueue(encoder.encode(sse(chunk({ content: event.text }, null))));
                return;
              }
              controller.enqueue(encoder.encode(sse(chunk({}, finishReason(event.finishReason)))));
              const usage = usageBlock(event.usage);
              if (req.includeUsage) controller.enqueue(encoder.encode(sse({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usage ?? null })));
              controller.enqueue(encoder.encode(sse('[DONE]')));
              controller.close();
              finishStream(true, { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens, source: event.usage.source });
            } catch (error) {
              if (!abort.signal.aborted) routing.failures.recordFailure(o.candidate.providerId);
              log?.info('stream ended with an error', { component: 'gateway', model, error: error instanceof Error ? error.message : String(error) });
              try {
                controller.enqueue(encoder.encode(sse({ error: { message: 'The model provider failed while streaming the response.', type: 'api_error', code: 'stream_interrupted', param: null } })));
                controller.close();
              } catch {
                // the client is already gone
              }
              finishStream(false);
            }
          },
          async cancel() {
            // The client disconnected: stop the provider call too (spec §13).
            abort.abort();
            await o.value.it.return?.(undefined).catch(() => {});
            finishStream(false);
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
      const req = parseEmbeddingRequest(body);
      const route = plan(key, req.model, 'EMBEDDINGS');
      return track(key, req.model, false, ctx, async (admission) => {
        const startedAt = performance.now();
        const o = await runAttempts(route, {
          signal: ctx.signal, failures: routing.failures, log, backoffMs: options.backoffMs, checkModel,
          call: (c, signal) => providers.embed(c.providerId, { model: c.providerModelId, input: req.input }, signal),
        });
        completed(key, req.model, false, ctx, o, startedAt, { inputTokens: o.value.usage.inputTokens, outputTokens: 0, source: o.value.usage.source }, admission);
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
