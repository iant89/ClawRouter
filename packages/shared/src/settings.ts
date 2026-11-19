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

/**
 * System and security settings (spec §16 settings.read/settings.write, §30
 * SETTINGS). Each one has a default from the server's environment (or a built-in
 * value) and can be changed from the console; a changed value takes precedence
 * over the environment until it is reset. Never secrets.
 */
export const SETTING_DEFINITIONS = {
  sessionIdleMinutes: {
    group: 'Security', label: 'Session idle timeout', unit: 'minutes', min: 1, max: 10_080, env: 'CLAWROUTER_SESSION_IDLE_MINUTES',
    description: 'A console session without activity for this long ends. Applies to existing sessions at once.',
  },
  sessionMaxHours: {
    group: 'Security', label: 'Maximum session length', unit: 'hours', min: 1, max: 720, env: 'CLAWROUTER_SESSION_MAX_HOURS',
    description: 'A console session ends this long after sign-in, even when active. Applies to new sessions.',
  },
  signInMaxFailures: {
    group: 'Security', label: 'Failed sign-ins before blocking', unit: 'attempts', min: 3, max: 100, env: null,
    description: 'Failed sign-ins for one username within 15 minutes before that username is blocked for 15 minutes.',
  },
  requestRetentionDays: {
    group: 'Data retention', label: 'Request history', unit: 'days', min: 0, max: 3650, env: 'CLAWROUTER_REQUEST_RETENTION_DAYS',
    description: 'Gateway request records older than this are deleted. 0 keeps them forever.',
  },
  usageRetentionDays: {
    group: 'Data retention', label: 'Usage records', unit: 'days', min: 0, max: 3650, env: 'CLAWROUTER_USAGE_RETENTION_DAYS',
    description: 'Hourly token and cost records older than this are deleted. 0 keeps them forever.',
  },
  healthHistoryDays: {
    group: 'Data retention', label: 'Health history', unit: 'days', min: 0, max: 365, env: 'CLAWROUTER_HEALTH_HISTORY_DAYS',
    description: 'Health check results older than this are deleted. 0 keeps them forever.',
  },
  keyMaxLifetimeDays: {
    group: 'API keys', label: 'Maximum key lifetime', unit: 'days', min: 1, max: 3650, env: null,
    description: 'The longest an API key may last when anyone other than an Administrator creates it (their own keys, keys from requests). Administrators may create keys that never expire. Applies to new keys.',
  },
  quotasEnabled: {
    group: 'Usage quotas', label: 'Enforce user quotas', unit: 'on/off', min: 0, max: 1, env: null, kind: 'switch',
    description: 'When off, no user quota refuses requests: quotas keep their settings and usage is still shown, but nothing is enforced until it is turned on again. Each quota can also be turned off on its own (Users → Usage quota).',
  },
  mcpEnabled: {
    group: 'MCP server', label: 'Let agents use the MCP server (/v1/mcp)', unit: 'on/off', min: 0, max: 1, env: null, kind: 'switch',
    description: "ClawRouter's own MCP server at /v1/mcp: read-only tools an agent such as Claude Code can use to ask about health, usage, requests, providers and models, with the permissions of its API key's owner. When off, /v1/mcp does not exist (404) and the console hides MCP access on keys; keys keep their MCP access for when it is turned on again.",
  },
  playgroundEnabled: {
    group: 'Playground', label: 'Let users chat in the playground', unit: 'on/off', min: 0, max: 1, env: null, kind: 'switch',
    description: 'Gateway → Playground: chat with a model in the console as one of your own API keys. When off, the menu item is hidden for everyone, the page says it has been disabled, and its API answers 403 with reason feature_disabled. When on, only roles with the playground.use permission can open it.',
  },
  noticeHeaderEnabled: {
    group: 'Client notices', label: 'Send notices in a response header', unit: 'on/off', min: 0, max: 1, env: null, kind: 'switch',
    description: 'Adds the X-ClawRouter-Notices header (a JSON list) to gateway responses that have a notice: degraded health, a failover, an announcement. Clients that do not read it are unaffected.',
  },
  noticeReplyEnabled: {
    group: 'Client notices', label: 'Write notices at the start of replies', unit: 'on/off', min: 0, max: 1, env: null, kind: 'switch',
    description: 'Puts notices as a line at the start of chat replies, where people in chat apps see them, like "⚠️ ClawRouter: …". Never on requests that use tools. Each API key can turn it off for itself (for scripts that read replies).',
  },
  noticeCleanupEnabled: {
    group: 'Client notices', label: 'Remove notices from conversations sent back', unit: 'on/off', min: 0, max: 1, env: null, kind: 'switch',
    description: 'Chat apps send earlier replies back with each new message. When on, ClawRouter removes its own notice lines from them before the provider sees them, so the model never reads or pays for them.',
  },
  noticeIntervalMinutes: {
    group: 'Client notices', label: 'Repeat system notices at most every', unit: 'minutes', min: 1, max: 1440, env: null,
    description: 'Degraded-health and failover notices go to each API key at most this often, so a long problem does not repeat in every reply. Announcements follow their own schedule.',
  },
  capturesEnabled: {
    group: 'Provider captures', label: 'Capture provider errors', unit: 'on/off', min: 0, max: 1, env: null, kind: 'switch',
    description: "Records the full exchange of a gateway request with its providers (what the client sent, every call to a provider and its raw reply, what the client got) when a provider call fails or its reply cannot be read, so it can be exported to a file for a developer. Also needed to start a manual capture (System → Captures). Captures contain users' prompts and replies; credentials are never recorded. When off, nothing is recorded; existing captures stay.",
  },
  capturesMaxCount: {
    group: 'Provider captures', label: 'Captures kept', unit: 'captures', min: 10, max: 10_000, env: null,
    description: 'Captures are kept until deleted; beyond this many, the oldest are deleted. Each capture holds up to 256 KB per body recorded.',
  },
} as const;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;
export const SETTING_KEYS = Object.keys(SETTING_DEFINITIONS) as SettingKey[];

export const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(SETTING_DEFINITIONS, key);

/** GET /api/settings */
export interface SettingInfo {
  key: SettingKey;
  group: string;
  label: string;
  description: string;
  unit: string;
  min: number;
  max: number;
  /** How the console shows it: a number, or a switch stored as 1 (on) or 0 (off). */
  kind: 'number' | 'switch';
  /** Environment variable that sets the default, if any. */
  env: string | null;
  /** The value in effect. */
  value: number;
  /** The value from the environment or the built-in default. */
  defaultValue: number;
  /** True when changed from the console (takes precedence over the environment). */
  overridden: boolean;
  updatedAt: string | null;
}

/** PUT /api/settings (settings.write). `null` resets a setting to its default. */
export interface UpdateSettingsRequest {
  values: Partial<Record<SettingKey, number | null>>;
}
