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

/** Provider vocabulary (spec §8, §9). Browser-safe; never carries credentials. */
export const PROVIDER_KINDS = ['openai', 'anthropic', 'google', 'groq', 'openrouter', 'openai_compatible'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const PROVIDER_STATES = ['UNKNOWN', 'HEALTHY', 'DEGRADED', 'OFFLINE', 'DISABLED'] as const;
export type ProviderState = (typeof PROVIDER_STATES)[number];

/** Model capabilities (spec §9). */
export const CAPABILITIES = ['CHAT', 'CODING', 'REASONING', 'VISION', 'EMBEDDINGS', 'TOOL_USE', 'RESEARCH'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Media a provider kind accepts inside chat messages: images by URL, images sent
 * inline (base64), audio (wav, mp3) and PDF documents (both inline).
 */
export const MEDIA_KINDS = ['image_url', 'image_data', 'audio', 'pdf'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** What a provider kind needs, for building forms. GET /api/providers/kinds */
export interface ProviderKindInfo {
  kind: ProviderKind;
  displayName: string;
  description: string;
  defaultEndpoint: string | null;
  endpointRequired: boolean;
  apiKeyRequired: boolean;
  capabilities: Capability[];
  supportsStreaming: boolean;
  /** Media accepted in chat messages; empty for text only. */
  inputMedia: MediaKind[];
}

/** The stored credential, as the console may see it: never the value. */
export interface CredentialInfo {
  configured: boolean;
  /** Last 4 characters, to tell keys apart (e.g. "…abcd"). */
  hint: string | null;
  updatedAt: string | null;
}

export interface ProviderInfo {
  id: string;
  name: string;
  /** Stable slug used by routing rules, e.g. "openai-prod". */
  identifier: string;
  kind: ProviderKind;
  endpoint: string;
  enabled: boolean;
  priority: number;
  timeoutMs: number;
  /** Longest an API key may live and still use this provider's models (hours); null: no limit. */
  maxKeyLifetimeHours: number | null;
  status: ProviderState;
  statusDetail: string | null;
  statusCheckedAt: string | null;
  latencyMs: number | null;
  capabilities: Capability[];
  credential: CredentialInfo;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderCheck {
  checkedAt: string;
  kind: 'TEST' | 'HEALTH';
  status: ProviderState;
  latencyMs: number | null;
  detail: string | null;
}

export interface ProviderDetail extends ProviderInfo {
  recentChecks: ProviderCheck[];
}

/** POST /api/providers/:id/test */
export interface ConnectionTestResult {
  ok: boolean;
  status: ProviderState;
  latencyMs: number | null;
  message: string;
  /** Number of models the provider reported, when it lists them. */
  modelCount: number | null;
  /** A few model ids, as a sanity check. */
  sampleModels: string[];
  checkedAt: string;
  /** The operation that ran the test (phase 12), to find it in the operations list. */
  operationId?: string;
}

export interface CreateProviderRequest {
  name: string;
  identifier: string;
  kind: ProviderKind;
  endpoint?: string;
  priority?: number;
  timeoutMs?: number;
  /** Maximum API key lifetime for this provider's models, in hours; null removes the limit. */
  maxKeyLifetimeHours?: number | null;
  enabled?: boolean;
  /** Write-only. */
  apiKey?: string;
}

export interface UpdateProviderRequest {
  name?: string;
  endpoint?: string;
  priority?: number;
  timeoutMs?: number;
  /** Maximum API key lifetime for this provider's models, in hours; null removes the limit. */
  maxKeyLifetimeHours?: number | null;
  enabled?: boolean;
}

export const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === 'string' && (PROVIDER_KINDS as readonly string[]).includes(value);
}
