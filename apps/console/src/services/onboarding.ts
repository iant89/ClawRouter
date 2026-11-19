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

import type { FinishTourRequest, SetupWizardState, TourState, UpdateSetupWizardRequest } from '@clawrouter/shared';
import { apiPost, apiPut } from './api-client.ts';

/** Saves where the setup wizard is, or ends it. */
export const updateSetupWizard = (body: UpdateSetupWizardRequest) => apiPut<SetupWizardState>('/api/onboarding/setup-wizard', body);

/** The signed-in user finished or skipped their guided tour. */
export const finishTour = (outcome: FinishTourRequest['outcome']) => apiPost<{ tour: TourState }>('/api/auth/tour', { outcome });

export interface TestRequestResult {
  ok: boolean;
  /** The model's answer, or what went wrong. */
  text: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  requestId: string | null;
}

/**
 * A real request through the gateway, as an application would send it: the API
 * key as a bearer token on /v1/chat/completions (never the console session).
 * The key stays in this page's memory only.
 */
export async function sendTestRequest(apiKey: string, model: string, prompt = 'Say hello to ClawRouter in one short sentence.'): Promise<TestRequestResult> {
  const started = performance.now();
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    credentials: 'omit',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 400 }),
  });
  const latencyMs = Math.round(performance.now() - started);
  const requestId = res.headers.get('x-request-id');
  const body = (await res.json().catch(() => null)) as {
    model?: string;
    choices?: { message?: { content?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string };
  } | null;
  if (!res.ok || !body?.choices) {
    return { ok: false, text: body?.error?.message ?? `The gateway answered ${res.status}.`, model: null, inputTokens: null, outputTokens: null, latencyMs, requestId };
  }
  return {
    ok: true,
    text: body.choices[0]?.message?.content?.trim() || '(an empty answer)',
    model: body.model ?? model,
    inputTokens: body.usage?.prompt_tokens ?? null,
    outputTokens: body.usage?.completion_tokens ?? null,
    latencyMs,
    requestId,
  };
}
