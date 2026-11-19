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

import type { FieldIssue } from '@clawrouter/shared';
import { checkEndpoint } from '../endpoint.ts';
import type { ChatMessage, DiscoveredModel, ProviderCallContext } from '../types.ts';

export function baseValidation(config: { endpoint: string; apiKey: string | null }, apiKeyRequired: boolean): FieldIssue[] {
  const issues = [...checkEndpoint(config.endpoint).issues];
  if (apiKeyRequired && !config.apiKey) issues.push({ path: 'apiKey', message: 'is required for this provider' });
  return issues;
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; latencyMs: number }> {
  const started = performance.now();
  const value = await fn();
  return { value, latencyMs: Math.round(performance.now() - started) };
}

/** testConnection and healthCheck both use the free "list models" call: no tokens spent. */
export function connectionChecks(listModels: (ctx: ProviderCallContext) => Promise<DiscoveredModel[]>) {
  return {
    async testConnection(ctx: ProviderCallContext) {
      const { value, latencyMs } = await timed(() => listModels(ctx));
      return { latencyMs, models: value };
    },
    async healthCheck(ctx: ProviderCallContext) {
      const { latencyMs } = await timed(() => listModels(ctx));
      return { latencyMs };
    },
  };
}

/** System messages go into a separate field for Anthropic and Google. */
export function splitSystem(messages: ChatMessage[]): { system: string | null; rest: ChatMessage[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  return { system: system || null, rest: messages.filter((m) => m.role !== 'system') };
}

/**
 * Classifies a model from its id when the provider gives no metadata. Only used
 * to pre-select capabilities on import; administrators can change them.
 */
export function guessKind(id: string): 'chat' | 'embedding' | 'other' {
  const lower = id.toLowerCase();
  if (/embed/.test(lower)) return 'embedding';
  if (/(whisper|tts|dall-e|image|moderation|transcribe|realtime|audio|davinci-00|babbage-00|rerank|guard)/.test(lower)) return 'other';
  return 'chat';
}
