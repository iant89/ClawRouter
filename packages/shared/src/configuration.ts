import type { Permission } from './authorization.ts';
import type { Capability, ProviderKind } from './providers.ts';
import type { RateLimitSettings } from './rate-limits.ts';
import type { ModelAlias, RoutingPolicy } from './routing.ts';
import type { SettingKey } from './settings.ts';
import type { MailSecurity, TwoFactorMethod, TwoFactorRequirement } from './two-factor.ts';

/**
 * Configuration export/import (phase 17): providers, models, routing, rate limits,
 * custom roles and settings as one JSON document. Never secrets: no provider API
 * keys, no mail password, no users, API keys, sessions or history.
 */
export const CONFIGURATION_FORMAT = 'clawrouter-configuration';

export interface ExportedProvider {
  identifier: string;
  name: string;
  kind: ProviderKind;
  endpoint: string;
  priority: number;
  timeoutMs: number;
  maxKeyLifetimeHours: number | null;
  enabled: boolean;
  /** Whether it had an API key when exported. Keys are never exported: enter them again. */
  hadApiKey: boolean;
}

export interface ExportedModel {
  /** The provider's identifier. */
  provider: string;
  providerModelId: string;
  displayName: string;
  capabilities: Capability[];
  contextLength: number | null;
  maxOutputTokens: number | null;
  enabled: boolean;
  cost: { inputPerMTok: number | null; outputPerMTok: number | null } | null;
  maxKeyLifetimeHours: number | null;
}

export interface ConfigurationDocument {
  format: typeof CONFIGURATION_FORMAT;
  formatVersion: 1;
  exportedAt: string;
  clawrouterVersion: string;
  providers: ExportedProvider[];
  models: ExportedModel[];
  routing: { defaultPolicy: RoutingPolicy; aliases: ModelAlias[] };
  rateLimits: RateLimitSettings;
  /** Custom roles only; built-in roles are the same everywhere. */
  roles: { name: string; description: string; permissions: Permission[] }[];
  settings: {
    /** Only values changed in the console (the rest keep each server's defaults). */
    system: Partial<Record<SettingKey, number>>;
    signIn: { methods: Record<TwoFactorMethod, boolean>; require: TwoFactorRequirement };
    /** Without the password, which is never exported. */
    mail: { enabled: boolean; host: string; port: number; security: MailSecurity; username: string | null; from: string };
  };
}

export const CONFIGURATION_SECTIONS = ['roles', 'providers', 'models', 'routing', 'rateLimits', 'settings'] as const;
export type ConfigurationSection = (typeof CONFIGURATION_SECTIONS)[number];

export interface ImportChange {
  section: ConfigurationSection;
  /** What it is: a provider identifier, a model ref, a role name, "routing". */
  name: string;
  action: 'create' | 'update' | 'unchanged' | 'skipped';
  /** Fields that change (updates). */
  fields?: string[];
  /** Why it is skipped, or what to do afterwards. */
  note?: string;
}

/** POST /api/configuration/import/preview: what an import would do. Nothing is changed. */
export interface ImportPlan {
  changes: ImportChange[];
  counts: Record<ConfigurationSection, { create: number; update: number; unchanged: number; skipped: number }>;
  /** Permissions the import needs that you do not hold: it is refused until someone who holds them imports. */
  missingPermissions: Permission[];
}

/** POST /api/configuration/import */
export interface ImportResult extends ImportPlan {
  /** The backup taken just before applying (null when the database is not on disk). */
  backup: string | null;
  /** Set when a change failed: changes before it were applied, the rest were not. */
  failed: { change: ImportChange; message: string } | null;
}
