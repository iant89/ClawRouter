import type { ProviderKind, ProviderKindInfo } from '@clawapi/shared';
import { anthropicAdapter } from './adapters/anthropic.ts';
import { googleAdapter } from './adapters/google.ts';
import { openAiAdapter, openAiCompatibleAdapter } from './adapters/openai.ts';
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
  return new ProviderRegistry().register(openAiAdapter).register(anthropicAdapter).register(googleAdapter).register(openAiCompatibleAdapter);
}
