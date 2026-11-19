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

import type { GatewayEndpoint, RequestAttempt } from './requests.ts';

/**
 * Provider captures (owner request, 2026-11-17): the full exchange of a gateway
 * request with its providers, recorded when something went wrong (or on request),
 * so it can be exported to a file and handed to a developer to fix. Credentials
 * are never recorded; message text is, unless masked when exporting.
 */

/** Why a capture was kept. */
export const CAPTURE_TRIGGERS = ['error', 'parse_error', 'manual'] as const;
export type CaptureTrigger = (typeof CAPTURE_TRIGGERS)[number];

export const CAPTURE_TRIGGER_LABELS: Record<CaptureTrigger, string> = {
  error: 'Provider error',
  parse_error: 'Unreadable reply',
  manual: 'Manual capture',
};

/** A recorded body: text (credentials removed), cut at a size limit. */
export interface CaptureBody {
  text: string;
  /** Bytes in the original body (more than `text` holds when truncated). */
  bytes: number;
  truncated: boolean;
}

/** One HTTP call from ClawRouter to a provider, as it went over the wire. */
export interface CaptureExchange {
  /** 1 for the first provider call of the request, 2 for the next (a retry or a failover)… */
  attempt: number;
  modelRef: string;
  providerId: string;
  providerName: string | null;
  providerKind: string | null;
  /** The attempt's outcome as request history shows it: ok, timeout, server_error, invalid_response… */
  outcome: string;
  /** ClawRouter's reading of the failure (credentials removed), when it failed. */
  error: string | null;
  startedAt: string;
  durationMs: number | null;
  request: { method: string; url: string; headers: Record<string, string>; body: CaptureBody | null };
  response: { status: number; headers: Record<string, string>; body: CaptureBody; complete: boolean } | null;
  /** No response (network error, timeout, cancelled), or a body that stopped part-way. */
  transportError: string | null;
}

/** What the client sent and what ClawRouter answered. */
export interface CaptureClient {
  request: { body: CaptureBody };
  /** For streams, the events sent until the request ended. Null when the request failed: `outcome` holds the error the client got. */
  response: { status: number; body: CaptureBody } | null;
}

export interface CaptureOutcome {
  status: string;
  httpStatus: number;
  errorCode: string | null;
  errorMessage: string | null;
}

/** GET /api/captures */
export interface CaptureSummary {
  id: string;
  createdAt: string;
  trigger: CaptureTrigger;
  requestId: string;
  endpoint: GatewayEndpoint;
  stream: boolean;
  requestedModel: string;
  /** The last model and provider tried. */
  modelRef: string | null;
  providerId: string | null;
  providerName: string | null;
  outcome: CaptureOutcome;
  exchangeCount: number;
  /** Size of the stored capture. */
  sizeBytes: number;
}

/** GET /api/captures/:id */
export interface CaptureDetail extends CaptureSummary {
  client: CaptureClient;
  attempts: RequestAttempt[];
  exchanges: CaptureExchange[];
}

/** A capture before it is stored. */
export type NewCapture = Omit<CaptureDetail, 'id' | 'createdAt' | 'sizeBytes'>;

/** A manual capture waiting for requests (GET /api/captures/manual). */
export interface ManualCaptureInfo {
  /** Only requests to this provider; null: any. */
  providerId: string | null;
  /** Only requests for this model (as requested, or the model reference tried); null: any. */
  model: string | null;
  total: number;
  remaining: number;
  startedAt: string;
  expiresAt: string;
  startedBy: string;
}

/** POST /api/captures/manual */
export interface StartManualCaptureRequest {
  providerId?: string | null;
  model?: string | null;
  /** How many matching requests to capture, 1–100. */
  count: number;
  /** Stop after this many minutes even if fewer requests came, 1–1440. */
  minutes: number;
}

export const MANUAL_CAPTURE_MAX_COUNT = 100;
export const MANUAL_CAPTURE_MAX_MINUTES = 1440;

/** GET /api/captures/state: the switch, the manual capture and what is stored. */
export interface CaptureState {
  /** The capturesEnabled setting: when off, nothing is recorded and no manual capture can start. */
  enabled: boolean;
  manual: ManualCaptureInfo | null;
  stored: number;
  /** The capturesMaxCount setting: the oldest captures are deleted beyond it. */
  maxCount: number;
}

/** POST /api/captures/export */
export interface ExportCapturesRequest {
  ids: string[];
  /** Replace message text (prompts, replies, tool arguments, images) with its length; structure and errors stay. */
  maskText: boolean;
}

/** The exported file. */
export interface CaptureExportFile {
  format: 'clawrouter-capture';
  version: 1;
  clawrouterVersion: string;
  exportedAt: string;
  masked: boolean;
  captures: CaptureDetail[];
}

/** At most this many captures in one export. */
export const CAPTURE_EXPORT_MAX = 50;

/**
 * What the gateway asks of the captures service before and after a request
 * (implemented by packages/captures, used by packages/gateway/src/capture.ts).
 */
export interface CaptureSink {
  /** True while captures are on: requests are then recorded, and kept only if something went wrong (or a manual capture claims them). */
  recording(): boolean;
  /** Takes one manual capture for a request that matches the running manual capture. */
  claimManual(match: { requestedModel: string; modelRefs: string[]; providerIds: string[] }): boolean;
  save(capture: NewCapture): void;
}
