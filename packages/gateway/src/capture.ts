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

import { scrubSecrets } from '@clawrouter/core';
import { ExchangeTap, ProviderCallError, TAP_BODY_LIMIT } from '@clawrouter/providers';
import type { CaptureBody, CaptureExchange, CaptureOutcome, CaptureSink, CaptureTrigger, GatewayEndpoint, RequestAttempt, RouteCandidate } from '@clawrouter/shared';
import { classify } from './executor.ts';

/** Client-side text, cut at the same limit as provider bodies. */
class TextCollector {
  private parts: string[] = [];
  private kept = 0;
  bytes = 0;

  add(text: string) {
    const size = new TextEncoder().encode(text).byteLength;
    this.bytes += size;
    if (this.kept >= TAP_BODY_LIMIT) return;
    const part = text.length > TAP_BODY_LIMIT - this.kept ? text.slice(0, TAP_BODY_LIMIT - this.kept) : text;
    this.parts.push(part);
    this.kept += part.length;
  }

  body(): CaptureBody {
    return { text: scrubSecrets(this.parts.join('')), bytes: this.bytes, truncated: this.bytes > this.kept };
  }
}

interface AttemptRecord {
  candidate: RouteCandidate;
  tap: ExchangeTap;
  error: unknown;
}

/**
 * Records one gateway request for provider captures: the client's body, every
 * provider call (through an ExchangeTap per attempt) and what the client got.
 * Created only while captures are on; at the end it keeps the recording when a
 * provider call failed or its reply could not be read, or when a manual capture
 * claims it, and drops it otherwise.
 */
export class RequestCapture {
  private readonly attempts: AttemptRecord[] = [];
  private readonly clientOut = new TextCollector();
  private clientStatus: number | null = null;
  private streamError: unknown = null;
  private ended = false;

  constructor(
    private readonly sink: CaptureSink,
    private readonly info: { requestId: string; endpoint: GatewayEndpoint; stream: boolean; requestedModel: string; clientBody: unknown },
    private readonly kindOf: (providerId: string) => string | null,
  ) {}

  /** Runs one provider attempt through a fresh tap, remembering how it ended. */
  async attempt<T>(candidate: RouteCandidate, call: (tap: ExchangeTap) => Promise<T>): Promise<T> {
    const record: AttemptRecord = { candidate, tap: new ExchangeTap(), error: null };
    this.attempts.push(record);
    try {
      return await call(record.tap);
    } catch (error) {
      record.error = error;
      throw error;
    }
  }

  /** What the client received (JSON answers whole; streams event by event). */
  clientResponse(status: number, text: string) {
    this.clientStatus = status;
    this.clientOut.add(text);
  }

  /** A stream that failed after it was committed to the client. */
  streamFailed(error: unknown) {
    this.streamError = error;
  }

  /** Decides whether to keep the recording, and keeps it. Safe to call more than once. */
  end(outcome: CaptureOutcome, trace: RequestAttempt[]): void {
    if (this.ended) return;
    this.ended = true;
    if (!this.attempts.some((a) => a.tap.count > 0)) return; // no provider was called: nothing to show
    const errors = [...this.attempts.map((a) => a.error), this.streamError].filter((e) => e !== null && !(e instanceof ProviderCallError && e.failure === 'cancelled'));
    const unreadable = errors.some((e) => e instanceof ProviderCallError && e.failure === 'invalid_response');
    let trigger: CaptureTrigger | null = unreadable ? 'parse_error' : errors.length ? 'error' : null;
    if (!trigger) {
      const claimed = this.sink.claimManual({
        requestedModel: this.info.requestedModel,
        modelRefs: this.attempts.map((a) => a.candidate.modelRef),
        providerIds: this.attempts.map((a) => a.candidate.providerId),
      });
      if (!claimed) return;
      trigger = 'manual';
    }

    const exchanges: CaptureExchange[] = [];
    this.attempts.forEach((a, i) => {
      const last = i === this.attempts.length - 1;
      const error = a.error ?? (last ? this.streamError : null);
      const message = error instanceof Error ? scrubSecrets(error.message) : error ? String(error) : null;
      for (const x of a.tap.exchanges()) {
        exchanges.push({
          attempt: i + 1, modelRef: a.candidate.modelRef, providerId: a.candidate.providerId, providerName: a.candidate.providerName,
          providerKind: this.kindOf(a.candidate.providerId), outcome: error ? classify(error).kind : 'ok', error: message, ...x,
        });
      }
    });
    const last = this.attempts.at(-1)!.candidate;
    const clientText = (() => {
      try {
        return JSON.stringify(this.info.clientBody, null, 2) ?? '';
      } catch {
        return '[the request body could not be recorded]';
      }
    })();
    const clientIn = new TextCollector();
    clientIn.add(clientText);
    this.sink.save({
      trigger, requestId: this.info.requestId, endpoint: this.info.endpoint, stream: this.info.stream, requestedModel: this.info.requestedModel,
      modelRef: last.modelRef, providerId: last.providerId, providerName: last.providerName, outcome,
      exchangeCount: exchanges.length, attempts: trace, exchanges,
      client: { request: { body: clientIn.body() }, response: this.clientStatus === null ? null : { status: this.clientStatus, body: this.clientOut.body() } },
    });
  }
}
