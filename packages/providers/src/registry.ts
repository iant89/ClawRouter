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

import type { ProviderKind, ProviderKindInfo } from '@clawrouter/shared';
import { anthropicAdapter } from './adapters/anthropic.ts';
import { googleAdapter } from './adapters/google.ts';
import { groqAdapter, openAiAdapter, openAiCompatibleAdapter } from './adapters/openai.ts';
import type { ProviderAdapter } from './types.ts';

/**
 * Provider kind -> implementation. Adding a provider means adding an adapter
 * here; the routing engine never changes (spec §2.3).
 */
export class ProviderRegistry {
  private readonly adapters = new Map<ProviderKind, ProviderAdapter>();

  register(adapter: ProviderAdapter): this {
    this.adapters.set(adapter.info.kind, adapter);
    return this;
  }

  get(kind: ProviderKind): ProviderAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`No adapter registered for provider kind "${kind}"`);
    return adapter;
  }

  has(kind: string): kind is ProviderKind {
    return this.adapters.has(kind as ProviderKind);
  }

  kinds(): ProviderKindInfo[] {
    return [...this.adapters.values()].map((a) => a.info);
  }
}

export function createDefaultRegistry(): ProviderRegistry {
  return new ProviderRegistry().register(openAiAdapter).register(anthropicAdapter).register(googleAdapter).register(groqAdapter).register(openAiCompatibleAdapter);
}
