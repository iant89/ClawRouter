/*
 * ClawRouter - Self-hosted AI gateway and control platform
 * https://github.com/iant89/ClawRouter
 *
 * Copyright (C) 2026 Ian Thomas
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * in the LICENSE file for more details.
 */

import { AppError, type EventBus, type Logger } from '@clawrouter/core';
import type { ModelService } from '@clawrouter/models';
import { mediaOf, ProviderCallError, type ProviderService, type StreamEvent } from '@clawrouter/providers';
import type { Admission, ModelDenial, RateLimitService } from '@clawrouter/rate-limits';
import type { RequestHandle, RequestLogService } from '@clawrouter/requests';
import type { RoutingService } from '@clawrouter/routing';
import { DEFAULT_REQUEST_LIMITS, formatLifetime, type RequestLimits, type CaptureSink, type NoticeSource, NOTICE_HEADER, type Capability, type GatewayEndpoint, type MediaKind, type ModelInfo, type RequestAttempt, type RouteCandidate, type RoutePlan, type UsageSource } from '@clawrouter/shared';

/** Routing exclusions caused by the key's age start with this (a readable sentence: plans and request history show it). */
const KEY_TOO_OLD = 'This API key is older than';
const NO_MEDIA = 'This provider does not accept';
const TOO_EXPENSIVE = 'The estimated cost of this request on';
const MEDIA_WORDS: Record<MediaKind, string> = { image_url: 'image URLs', image_data: 'inline images', audio: 'audio', pdf: 'PDF files' };
import { modelAllowed, type ApiKeyPrincipal } from './api-keys.ts';
import { cancelled, ModelsRateLimitedError, runAttempts, type AttemptOutcome } from './executor.ts';
import { GatewayMetricsRecorder } from './metrics.ts';
import { invalid, parseChatRequest, parseEmbeddingRequest, unixTime, type ParsedChatRequest } from './openai.ts';
import { chatCompletionsFormat, type ChatFormatter } from './formats.ts';
import { parseResponsesRequest, renamed, responsesFormat } from './responses.ts';
import { messagesFormat, messagesRenamed, parseMessagesRequest } from './messages.ts';
import { RequestCapture } from './capture.ts';
import { enforceChatLimits, enforceEmbeddingLimits, estimateChatInput, estimateRequestCost, limitError } from './request-limits.ts';
import { headerValue, replyPrefix, stripNotices } from '@clawrouter/notices';
import type { ExchangeTap } from '@clawrouter/providers';

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
  /** The provider's own charge, when it reports one. */
  costUsd?: number | null;
}

/** Rough local token count (about four characters per token), used only when the provider reports none. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

/** Fills in token counts the provider did not report with a local estimate (spec §23). */
function withEstimate(reported: Usage, inputChars: number, outputChars: number): Usage {
  const input = reported.inputTokens ?? estimateTokens(inputChars);
  const output = reported.outputTokens ?? estimateTokens(outputChars);
  const estimated = reported.inputTokens === null || reported.outputTokens === null;
  return { inputTokens: input, outputTokens: output, source: estimated ? 'estimated' : 'provider', ...(typeof reported.costUsd === 'number' ? { costUsd: reported.costUsd } : {}) };
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
  /** Usage quotas per user: checked before the rate limits; a used-up quota refuses the request. */
  quotas?: { check(userId: string | null, requestId: string | null): void };
  /** Request history and usage (phase 10). Without it nothing is recorded. */
  requests?: RequestLogService;
  metrics?: GatewayMetricsRecorder;
  /** Provider captures: the full exchange of requests that went wrong. Without it nothing is recorded. */
  captures?: CaptureSink;
  /** Client notices (header, reply text) and the cleanup of notices sent back. Without it, none. */
  notices?: NoticeSource;
  now?: () => Date;
  backoffMs?: number;
}) {
  const { routing, providers, models, events, log, limits, requests, quotas } = options;
  const now = options.now ?? (() => new Date());
  const metrics = options.metrics ?? new GatewayMetricsRecorder(() => now().getTime(), () => limits?.rejections() ?? { lastMinute: 0, total: 0 });
  const encoder = new TextEncoder();
  const unlimited: Admission = { headers: {}, charge: async () => {}, release: async () => {} };
  const checkModel = limits ? (c: RouteCandidate) => limits.useModel(c.modelRef, c.providerId) : undefined;
  const noRecord: RequestHandle = { streaming: () => {}, finish: () => null };
  const requestLimits = (): RequestLimits => limits?.requestLimits() ?? DEFAULT_REQUEST_LIMITS;

  /**
   * maxEstimatedCostPerRequest (SEC-005): a model on which this request could cost
   * more (input estimate plus the most it may write) is left out of the route.
   * Unpriced models cannot be estimated and are not left out.
   */
  function costExclusion(inputTokens: number, maxOutput: number | undefined): ((m: ModelInfo) => string | null) | undefined {
    const max = limits?.maxEstimatedCostPerRequest() ?? null;
    if (max === null) return undefined;
    return (m) => {
      const usd = estimateRequestCost(m.cost, inputTokens, maxOutput ?? m.maxOutputTokens ?? 0);
      return usd !== null && usd > max ? `${TOO_EXPENSIVE} ${m.ref} ($${usd.toFixed(4)}) is above the $${max} limit per request.` : null;
    };
  }

  /**
   * A model with a maximum key lifetime refuses keys older than that (owner's
   * rule), whatever the key's own expiry: it also covers keys for "any model"
   * and limits set after the key was created.
   */
  function tooOldFor(key: ApiKeyPrincipal, m: ModelInfo): string | null {
    const limit = m.keyLifetimeLimit;
    if (!limit || now().getTime() - Date.parse(key.createdAt) <= limit.hours * 3_600_000) return null;
    return `${KEY_TOO_OLD} the ${formatLifetime(limit.hours)} maximum key lifetime for ${m.ref} (set on the ${limit.source}).`;
  }

  /** Route, translating "nothing to route to" into client-facing errors. */
  function plan(
    key: ApiKeyPrincipal, model: string, capability: Capability, media: Set<MediaKind> = new Set(), tools = false,
    tooExpensive?: (m: ModelInfo) => string | null,
  ): RoutePlan {
    if (!modelAllowed(key, model)) throw new AppError('AUTHORIZATION_ERROR', `This API key is not allowed to use the model '${model}'.`, { details: { param: 'model' } });
    // Media: images need a model marked Vision, and every medium a provider that accepts it.
    // Tools need a model marked Tool use.
    const capabilities: Capability[] = [capability, ...(media.has('image_url') || media.has('image_data') ? ['VISION' as const] : []), ...(tools ? ['TOOL_USE' as const] : [])];
    const accepted = new Map(providers.kinds().map((k) => [k.kind, new Set(k.inputMedia)]));
    const refusesMedia = (m: ModelInfo): string | null => {
      const missing = [...media].filter((kind) => !accepted.get(m.provider.kind)?.has(kind));
      return missing.length ? `${NO_MEDIA} ${missing.map((k) => MEDIA_WORDS[k]).join(' or ')}.` : null;
    };
    try {
      return routing.plan({ model, capabilities, exclude: (m) => tooOldFor(key, m) ?? (media.size ? refusesMedia(m) : null) ?? tooExpensive?.(m) ?? null });
    } catch (error) {
      if (error instanceof AppError && error.code === 'ROUTING_ERROR') {
        // Everything left out because the key outlived the models' maximum lifetime: a 403 that says so.
        const excluded = (error.details?.excluded ?? []) as { reason: string }[];
        // Everything left out because the request could cost too much on each model: the request as sent (400).
        const costly = excluded.filter((e) => e.reason.startsWith(TOO_EXPENSIVE));
        if (costly.length && costly.length === excluded.length) {
          throw limitError('maxEstimatedCostPerRequest', `${costly[0]!.reason} Send a smaller request or a lower max_tokens.`, 'messages');
        }
        const stale = excluded.filter((e) => e.reason.startsWith(KEY_TOO_OLD));
        if (stale.length && stale.length === excluded.length) {
          throw new AppError('AUTHORIZATION_ERROR', `${stale[0]!.reason} Create a new key.`, { expose: true, details: { param: 'model', code: 'key_too_old' } });
        }
        // Everything left out because of the media: the request cannot be served as sent (400, not a retry).
        // Everything left out because no model supports tools: also the request as sent.
        if (tools && excluded.length && excluded.every((e) => /Missing capabilities:.*TOOL_USE/.test(e.reason))) {
          throw invalid(`No model for '${model}' supports tools. Mark the models that do as Tool use (Models → edit).`, 'tools');
        }
        const forMedia = excluded.filter((e) => e.reason.startsWith(NO_MEDIA) || e.reason.includes('Missing capabilities: VISION'));
        if (media.size && excluded.length && forMedia.length === excluded.length) {
          const what = [...media].map((k) => MEDIA_WORDS[k]).join(', ');
          const hints = [
            ...(media.has('image_url') || media.has('image_data') ? ['Images need a model marked Vision.'] : []),
            ...(media.has('image_url') ? ['Google takes images inline only (data URLs).'] : []),
            ...(media.has('audio') ? ['Audio goes to OpenAI and Google only.'] : []),
            ...(media.has('pdf') ? ['PDFs go to OpenAI, Anthropic and Google only.'] : []),
          ];
          throw invalid(`No model for '${model}' accepts ${what}. ${hints.join(' ')}`, 'messages');
        }
        if (error.message.startsWith('Unknown model')) throw new AppError('NOT_FOUND', `The model '${model}' does not exist.`, { details: { param: 'model', code: 'model_not_found' } });
        throw new AppError('SERVICE_UNAVAILABLE', `No model is available for '${model}' right now.`, { expose: true, details: { param: 'model' } });
      }
      throw error;
    }
  }

  /**
   * Notices for one answer: the header value, and the text that starts the reply.
   * `replyAllowed` is false where text would break the client (tools, embeddings).
   */
  function noticesFor(key: ApiKeyPrincipal, o: Pick<AttemptOutcome<unknown>, 'candidate' | 'failovers'>, replyAllowed: boolean) {
    const n = options.notices?.noticesFor({
      keyId: key.id, ownerId: key.ownerId, failedOver: o.failovers > 0, providerStatus: o.candidate.providerStatus, replyAllowed: replyAllowed && key.replyNotices,
    });
    return {
      headers: (n?.header.length ? { [NOTICE_HEADER]: headerValue(n.header) } : {}) as Record<string, string>,
      prefix: n?.reply.length ? replyPrefix(n.reply) : '',
    };
  }

  /** Removes ClawRouter's own notice lines from assistant messages a client sent back (cleanup setting). */
  function withoutNotices<T extends { role: string; content: string }>(messages: T[]): T[] {
    if (!options.notices?.cleanupEnabled()) return messages;
    return messages.map((m) => {
      if (m.role !== 'assistant') return m;
      const content = stripNotices(m.content);
      return content === m.content ? m : { ...m, content };
    });
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
    const stream = endpoint !== 'embeddings' && raw.stream === true;
    const record = requests?.begin({ id: ctx.requestId, endpoint, stream, apiKeyId: key.id, userId: key.ownerId, requestedModel }) ?? noRecord;
    const t0 = performance.now();
    const trace: RequestAttempt[] = [];
    let admission = unlimited;
    let started = false;
    let ended = false;
    const elapsed = () => Math.round(performance.now() - t0);
    // Provider captures: recorded only while captures are on; kept only when something went wrong (or a manual capture claims it).
    const capture = options.captures?.recording()
      ? new RequestCapture(options.captures, { requestId: ctx.requestId, endpoint, stream, requestedModel, clientBody: body }, (id) => {
        try {
          return providers.get(id).kind;
        } catch {
          return null;
        }
      })
      : null;

    /** Attempts and model switches as the trace saw them (models skipped for their rate limit are not attempts). */
    const counts = () => {
      const made = trace.filter((t) => t.outcome !== 'skipped_rate_limit');
      const models = new Set(made.map((t) => t.modelRef));
      const last = made.at(-1) ?? trace.at(-1) ?? null;
      return { attempts: made.length, failovers: Math.max(0, models.size - 1), retries: made.length - models.size, last };
    };

    return {
      trace,
      capture,

      /** One provider attempt, through a capture tap when recording. */
      call<T>(c: RouteCandidate, fn: (tap: ExchangeTap | undefined) => Promise<T>): Promise<T> {
        return capture ? capture.attempt(c, fn) : fn(undefined);
      },
      get admission() {
        return admission;
      },

      /** Quota, then rate limits; a refused request never counts as started. */
      async admit() {
        quotas?.check(key.ownerId, ctx.requestId);
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
        const costUsd = record.finish({
          status: 'COMPLETED', httpStatus: 200, durationMs, modelRef: o.candidate.modelRef, providerId: o.candidate.providerId,
          attempts: c.attempts, retries: c.retries, failovers: c.failovers, attemptLog: trace, errorCode: null, errorMessage: null, usage,
        });
        limits?.chargeCost({ keyId: key.id, ownerId: key.ownerId, modelRef: o.candidate.modelRef, providerId: o.candidate.providerId }, costUsd);
        capture?.end({ status: 'COMPLETED', httpStatus: 200, errorCode: null, errorMessage: null }, trace);
      },

      /** Records a failure and returns the error to throw (rate-limit exhaustion becomes a 429). */
      fail(caught: unknown, override?: { status: 'FAILED' | 'CANCELLED'; httpStatus: number; code: string; message: string }, partial?: Usage): unknown {
        let error = caught;
        if (caught instanceof ModelsRateLimitedError && limits) {
          error = limits.modelsExhausted(caught.modelRef, caught.denial as ModelDenial, ctx.requestId);
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
        const usage = partial ?? { inputTokens: null, outputTokens: null, source: 'none' as const };
        const costUsd = record.finish({
          status: outcome.status, httpStatus: outcome.httpStatus, durationMs, modelRef: c.last?.modelRef ?? null, providerId: c.last?.providerId ?? null,
          attempts: c.attempts, retries: c.retries, failovers: c.failovers, attemptLog: trace, errorCode: outcome.code, errorMessage: outcome.message, usage,
        });
        // A stream that ended early still used the provider: its estimated usage counts against token and cost limits.
        if (partial && c.last) {
          const tokens = (partial.inputTokens ?? 0) + (partial.outputTokens ?? 0);
          void admission.charge(tokens).catch((err: unknown) => log?.error('rate-limit charge failed', { component: 'gateway', error: err }));
          if (limits) void limits.chargeModel(c.last.modelRef, tokens).catch((err: unknown) => log?.error('rate-limit charge failed', { component: 'gateway', error: err }));
          limits?.chargeCost({ keyId: key.id, ownerId: key.ownerId, modelRef: c.last.modelRef, providerId: c.last.providerId }, costUsd);
        }
        capture?.end({ status: outcome.status, httpStatus: outcome.httpStatus, errorCode: outcome.code, errorMessage: outcome.message }, trace);
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

  /**
   * One chat request, whatever API it came in through: parse, route, admit, call
   * with failover, record, and write the answer with the API's formatter. Streams
   * can fail over until the first event arrives; after that the response is
   * committed and a failure ends the stream with the format's error event.
   */
  function runChat(
    key: ApiKeyPrincipal, endpoint: GatewayEndpoint, body: unknown, ctx: GatewayRequestContext,
    prepare: (body: unknown) => { req: ParsedChatRequest; format: ChatFormatter },
  ): Promise<GatewayResult> {
    const run = startRun(key, endpoint, body, ctx);
    return recorded(run, async () => {
      const prepared = prepare(body);
      const format = prepared.format;
      // Notice lines ClawRouter wrote into earlier replies never reach the provider (cleanup setting).
      const cleaned = { ...prepared.req, messages: withoutNotices(prepared.req.messages) };
      // Request resource limits (SEC-006); the output limit may lower max_tokens.
      const req = enforceChatLimits(cleaned, requestLimits());
      const route = plan(key, req.model, 'CHAT', mediaOf(req.messages), req.usesTools, costExclusion(estimateChatInput(req), req.maxTokens));
      await run.admit();
      const promptChars = req.messages.reduce((n, m) => n + m.content.length, 0);
      const chatRequest = (c: RouteCandidate) => ({
        model: c.providerModelId, messages: req.messages, maxTokens: req.maxTokens, temperature: req.temperature, topP: req.topP, stop: req.stop,
        tools: req.tools, toolChoice: req.toolChoice, parallelToolCalls: req.parallelToolCalls,
      });

      if (!req.stream) {
        const o = await runAttempts(route, {
          signal: ctx.signal, failures: routing.failures, log, backoffMs: options.backoffMs, checkModel, trace: run.trace,
          call: (c, signal) => run.call(c, (tap) => providers.chat(c.providerId, chatRequest(c), signal, tap)),
        });
        // Never written into replies that call tools: the client reads those as data.
        const notices = noticesFor(key, o, !req.usesTools && !o.value.toolCalls?.length);
        const answer = format.complete(notices.prefix ? { ...o.value, content: notices.prefix + o.value.content } : o.value, o.candidate.modelRef);
        run.capture?.clientResponse(200, JSON.stringify(answer, null, 2));
        run.succeed(o, withEstimate(o.value.usage, promptChars, o.value.content.length + (o.value.reasoning?.length ?? 0)));
        return { kind: 'json', status: 200, headers: { ...routeHeaders(o), ...notices.headers }, body: answer };
      }

      const abort = new AbortController();
      const onClientGone = () => abort.abort();
      ctx.signal.addEventListener('abort', onClientGone, { once: true });
      let o: AttemptOutcome<{ it: AsyncIterator<StreamEvent>; first: IteratorResult<StreamEvent> }>;
      try {
        o = await runAttempts(route, {
          signal: abort.signal, failures: routing.failures, log, backoffMs: options.backoffMs, checkModel, trace: run.trace,
          call: async (c, signal) => {
            return run.call(c, async (tap) => {
              const it = providers.chatStream(c.providerId, chatRequest(c), signal, tap)[Symbol.asyncIterator]();
              const first = await it.next();
              return { it, first };
            });
          },
        });
      } catch (error) {
        ctx.signal.removeEventListener('abort', onClientGone);
        throw error;
      }
      run.streaming();
      const model = o.candidate.modelRef;
      // The notice text goes first, before anything the model writes; never on requests that offer tools.
      const notices = noticesFor(key, o, !req.usesTools);
      let outputChars = 0;
      let done = false;
      // maxStreamSeconds (SEC-006): a stream still running after this is ended (the provider call is aborted).
      const maxStreamSeconds = requestLimits().maxStreamSeconds;
      let timedOut = false;
      const streamTimer = maxStreamSeconds === null ? null : setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, maxStreamSeconds * 1000);
      const finishStream = (outcome: { ok: true; usage: Usage } | { ok: false }) => {
        if (done) return;
        done = true;
        if (streamTimer) clearTimeout(streamTimer);
        ctx.signal.removeEventListener('abort', onClientGone);
        if (outcome.ok) return run.succeed(o, withEstimate(outcome.usage, promptChars, outputChars));
        // The provider read the prompt and wrote part of an answer: that usage is estimated and counted.
        const partial = withEstimate({ inputTokens: null, outputTokens: null, source: 'none' }, promptChars, outputChars);
        if (timedOut) run.fail(null, { status: 'FAILED', httpStatus: 200, code: 'STREAM_TIME_LIMIT', message: `The stream was ended after the ${maxStreamSeconds} s limit.` }, partial);
        else if (abort.signal.aborted) run.fail(cancelled(), undefined, partial);
        else run.fail(null, { status: 'FAILED', httpStatus: 200, code: 'STREAM_INTERRUPTED', message: 'The model provider failed while streaming the response.' }, partial);
      };
      const send = (controller: ReadableStreamDefaultController<Uint8Array>, events: string[]) => {
        for (const e of events) controller.enqueue(encoder.encode(e));
        if (run.capture) for (const e of events) run.capture.clientResponse(200, e);
      };

      let pending: IteratorResult<StreamEvent> | null = o.value.first;
      let started = false;
      const stream = new ReadableStream<Uint8Array>({
        // pull() is called only when the client is ready for more: nothing is buffered beyond one event.
        async pull(controller) {
          try {
            if (!started) {
              started = true;
              send(controller, format.start(model));
              if (notices.prefix) send(controller, format.text(notices.prefix));
              return;
            }
            const next = pending ?? (await o.value.it.next());
            pending = null;
            if (abort.signal.aborted) throw cancelled();
            if (next.done) {
              send(controller, format.end());
              controller.close();
              finishStream({ ok: true, usage: { inputTokens: null, outputTokens: null, source: 'none' } });
              return;
            }
            const event = next.value;
            if (event.type === 'delta') {
              outputChars += event.text.length;
              send(controller, format.text(event.text));
              return;
            }
            if (event.type === 'reasoning') {
              outputChars += event.text.length;
              send(controller, format.reasoning(event.text));
              return;
            }
            if (event.type === 'tool_call') {
              outputChars += (event.name?.length ?? 0) + (event.arguments?.length ?? 0);
              send(controller, format.toolCall(event));
              return;
            }
            send(controller, format.finish(event.finishReason, event.usage));
            controller.close();
            finishStream({ ok: true, usage: event.usage });
          } catch (error) {
            if (!abort.signal.aborted) routing.failures.recordFailure(o.candidate.providerId);
            run.capture?.streamFailed(error);
            log?.info('stream ended with an error', { component: 'gateway', model, error: error instanceof Error ? error.message : String(error) });
            try {
              send(controller, format.error());
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
        headers: { ...routeHeaders(o), ...notices.headers, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' },
      };
    });
  }


  return {
    metrics,

    /** Body size and nesting limits for /v1 (read by the HTTP layer before parsing). */
    bodyLimits(): { maxBytes: number; maxDepth: number } {
      const l = requestLimits();
      return { maxBytes: l.maxRequestBytes, maxDepth: l.maxJsonDepth };
    },

    /** GET /v1/models: enabled aliases and usable models, limited to what the key may use. */
    listModels(key: ApiKeyPrincipal) {
      const config = routing.get();
      const created = unixTime(now());
      const aliases = config.aliases.filter((a) => a.enabled).map((a) => ({ id: a.name, object: 'model', created: config.updatedAt ? unixTime(new Date(config.updatedAt)) : created, owned_by: 'clawrouter' }));
      const refs = models.listUsable().filter((m) => !tooOldFor(key, m)).map((m) => ({ id: m.ref, object: 'model', created: unixTime(new Date(m.createdAt)), owned_by: m.provider.identifier }));
      return { object: 'list', data: [...aliases, ...refs].filter((m) => modelAllowed(key, m.id)) };
    },

    /** POST /v1/chat/completions */
    chat(key: ApiKeyPrincipal, body: unknown, ctx: GatewayRequestContext): Promise<GatewayResult> {
      return runChat(key, 'chat.completions', body, ctx, (raw) => {
        const req = parseChatRequest(raw);
        return { req, format: chatCompletionsFormat({ id: `chatcmpl-${ctx.requestId.replace(/^req_/, '')}`, created: unixTime(now()), includeUsage: req.includeUsage }) };
      });
    },

    /** POST /v1/responses: the Responses API, translated to the same pipeline (stateless: nothing is stored). */
    responses(key: ApiKeyPrincipal, body: unknown, ctx: GatewayRequestContext): Promise<GatewayResult> {
      return runChat(key, 'responses', body, ctx, (raw) => {
        const { req, echo } = parseResponsesRequest(raw);
        return { req, format: responsesFormat({ id: `resp_${ctx.requestId.replace(/^req_/, '')}`, createdAt: unixTime(now()), echo }) };
      }).catch((error: unknown) => {
        // Refusals from routing name Chat Completions fields; say them in Responses terms.
        throw renamed(error);
      });
    },

    /** POST /v1/messages: the Anthropic Messages API, translated to the same pipeline (so Claude clients can use any provider). */
    messages(key: ApiKeyPrincipal, body: unknown, ctx: GatewayRequestContext): Promise<GatewayResult> {
      return runChat(key, 'messages', body, ctx, (raw) => {
        const { req, estimatedInputTokens } = parseMessagesRequest(raw);
        return { req, format: messagesFormat({ id: `msg_${ctx.requestId.replace(/^req_/, '')}`, estimatedInputTokens }) };
      }).catch((error: unknown) => {
        throw messagesRenamed(error);
      });
    },

    /**
     * POST /v1/messages/count_tokens: an estimate (about four characters per token),
     * after the same checks as a real request (the key may use the model, the model
     * exists and can take the request). Nothing is sent to a provider or recorded.
     */
    countMessageTokens(key: ApiKeyPrincipal, body: unknown): { input_tokens: number } {
      const { req, estimatedInputTokens } = parseMessagesRequest(body, { countOnly: true });
      enforceChatLimits(req, requestLimits());
      plan(key, req.model, 'CHAT', mediaOf(req.messages), req.usesTools);
      return { input_tokens: estimatedInputTokens };
    },

    /** POST /v1/embeddings */
    async embeddings(key: ApiKeyPrincipal, body: unknown, ctx: GatewayRequestContext): Promise<GatewayResult> {
      const run = startRun(key, 'embeddings', body, ctx);
      return recorded(run, async () => {
        const req = parseEmbeddingRequest(body);
        enforceEmbeddingLimits(req, requestLimits());
        const route = plan(key, req.model, 'EMBEDDINGS');
        await run.admit();
        const o = await runAttempts(route, {
          signal: ctx.signal, failures: routing.failures, log, backoffMs: options.backoffMs, checkModel, trace: run.trace,
          call: (c, signal) => run.call(c, (tap) => providers.embed(c.providerId, { model: c.providerModelId, input: req.input }, signal, tap)),
        });
        const inputChars = req.input.reduce((n, s) => n + s.length, 0);
        const prompt = o.value.usage.inputTokens;
        const answer = {
          object: 'list', model: o.candidate.modelRef,
          data: o.value.embeddings.map((embedding, index) => ({ object: 'embedding', index, embedding })),
          ...(prompt !== null ? { usage: { prompt_tokens: prompt, total_tokens: prompt } } : {}),
        };
        run.capture?.clientResponse(200, JSON.stringify(answer));
        run.succeed(o, withEstimate({ inputTokens: o.value.usage.inputTokens, outputTokens: 0, source: o.value.usage.source }, inputChars, 0));
        return { kind: 'json', status: 200, headers: { ...routeHeaders(o), ...noticesFor(key, o, false).headers }, body: answer };
      });
    },

    /** POST /v1/responses: not offered yet; a clear error instead of a generic 404. */
  };
}
