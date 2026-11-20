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

import type { SettingKey } from './settings.ts';

/**
 * SEC-016: every configuration value has a security class. The class decides where
 * the value may appear:
 *
 * | Class             | Logs | API (normal) | MCP | Errors | Exports |
 * |-------------------|------|--------------|-----|--------|---------|
 * | PUBLIC            | yes  | anyone signed in | yes | yes | yes   |
 * | SENSITIVE         | yes  | with the read permission | with it | yes | yes |
 * | SECRET            | never | never (write-only; "configured" and a hint at most) | never | never | never |
 * | SECURITY_CRITICAL | never | never        | never | never | never |
 *
 * SECRET values are single credentials (a provider API key, the mail password, an
 * authenticator secret). SECURITY_CRITICAL values protect the whole installation
 * (the key that encrypts every secret, the one-time setup token, the TLS private
 * key): losing one compromises everything else.
 *
 * `tests/security/configuration/classification.test.ts` enforces the table: every
 * environment variable, setting and exported field must be classified here, and
 * planted SECRET / SECURITY_CRITICAL values are searched for in logs, API answers,
 * MCP answers, errors and exports.
 */
export const CONFIG_CLASSES = ['PUBLIC', 'SENSITIVE', 'SECRET', 'SECURITY_CRITICAL'] as const;
export type ConfigClass = (typeof CONFIG_CLASSES)[number];

/** SECRET and SECURITY_CRITICAL: never logged, returned, exported, imported or put in an error. */
export const isProtectedClass = (c: ConfigClass): boolean => c === 'SECRET' || c === 'SECURITY_CRITICAL';

/** Environment variables read by the server and its command-line tools. */
export const ENVIRONMENT_CLASSIFICATION: Record<string, ConfigClass> = {
  NODE_ENV: 'PUBLIC',
  CLAWROUTER_ENV: 'PUBLIC',
  CLAWROUTER_HOST: 'SENSITIVE',
  CLAWROUTER_PORT: 'PUBLIC',
  CLAWROUTER_TLS_CERT_FILE: 'SENSITIVE',
  // The path is sensitive; the file it names holds the private key, which is SECURITY_CRITICAL.
  CLAWROUTER_TLS_KEY_FILE: 'SENSITIVE',
  CLAWROUTER_TRUSTED_PROXIES: 'SENSITIVE',
  CLAWROUTER_OUTBOUND_ALLOWLIST: 'SENSITIVE',
  CLAWROUTER_SHUTDOWN_GRACE_SECONDS: 'PUBLIC',
  CLAWROUTER_REUSE_PORT: 'PUBLIC',
  CLAWROUTER_CONSOLE_ENABLED: 'PUBLIC',
  CLAWROUTER_DATABASE_PATH: 'SENSITIVE',
  CLAWROUTER_MIGRATIONS: 'PUBLIC',
  CLAWROUTER_BACKUP_BEFORE_MIGRATE: 'PUBLIC',
  CLAWROUTER_BACKUP_DIR: 'SENSITIVE',
  CLAWROUTER_BACKUP_INTERVAL_HOURS: 'PUBLIC',
  CLAWROUTER_BACKUP_KEEP: 'PUBLIC',
  CLAWROUTER_SECRET_KEY: 'SECURITY_CRITICAL',
  CLAWROUTER_SECRET_KEY_FILE: 'SENSITIVE',
  CLAWROUTER_NEW_SECRET_KEY: 'SECURITY_CRITICAL',
  CLAWROUTER_SETUP_TOKEN: 'SECURITY_CRITICAL',
  // Release tooling only (scripts/release.ts, SEC-020): the key that signs every release.
  CLAWROUTER_RELEASE_SIGNING_KEY: 'SECURITY_CRITICAL',
  CLAWROUTER_RELEASE_SIGNING_KEY_FILE: 'SENSITIVE',
  CLAWROUTER_SESSION_IDLE_MINUTES: 'PUBLIC',
  CLAWROUTER_SESSION_MAX_HOURS: 'PUBLIC',
  CLAWROUTER_COOKIE_SECURE: 'SENSITIVE',
  CLAWROUTER_LOG_LEVEL: 'PUBLIC',
  CLAWROUTER_LOG_FORMAT: 'PUBLIC',
  CLAWROUTER_LOG_BUFFER_SIZE: 'PUBLIC',
  CLAWROUTER_REQUEST_LOGGING: 'SENSITIVE',
  CLAWROUTER_REQUEST_RETENTION_DAYS: 'SENSITIVE',
  CLAWROUTER_USAGE_RETENTION_DAYS: 'SENSITIVE',
  CLAWROUTER_HEALTH_INTERVAL_SECONDS: 'PUBLIC',
  CLAWROUTER_HEALTH_HISTORY_DAYS: 'PUBLIC',
  CLAWROUTER_PROVIDER_HEALTH_INTERVAL_SECONDS: 'PUBLIC',
};

/**
 * Console settings (Administration → Settings). Settings are never secrets: a
 * SECRET or SECURITY_CRITICAL value must not become a setting. PUBLIC ones reach
 * every signed-in user through the session (they decide what the console shows).
 */
export const SETTING_CLASSIFICATION: Record<SettingKey, Exclude<ConfigClass, 'SECRET' | 'SECURITY_CRITICAL'>> = {
  sessionIdleMinutes: 'PUBLIC',
  sessionMaxHours: 'PUBLIC',
  signInMaxFailures: 'SENSITIVE',
  requestLogging: 'SENSITIVE',
  requestRetentionDays: 'SENSITIVE',
  usageRetentionDays: 'SENSITIVE',
  healthHistoryDays: 'SENSITIVE',
  keyMaxLifetimeDays: 'PUBLIC',
  quotasEnabled: 'SENSITIVE',
  mcpEnabled: 'PUBLIC',
  playgroundEnabled: 'PUBLIC',
  noticeHeaderEnabled: 'SENSITIVE',
  noticeReplyEnabled: 'SENSITIVE',
  noticeCleanupEnabled: 'SENSITIVE',
  noticeIntervalMinutes: 'SENSITIVE',
  capturesEnabled: 'SENSITIVE',
  capturesMaxCount: 'SENSITIVE',
};

/**
 * The configuration document (export and import), by path: `providers[].endpoint`
 * is the endpoint of every provider. An entry covers everything below it unless a
 * longer path says otherwise (`rateLimits` covers every limit). Protected entries
 * name values that exist in ClawRouter but are never in the document: an import
 * carrying one is refused (SEC-017).
 */
export const CONFIGURATION_FIELD_CLASSIFICATION: Record<string, ConfigClass> = {
  format: 'PUBLIC',
  formatVersion: 'PUBLIC',
  exportedAt: 'PUBLIC',
  clawrouterVersion: 'PUBLIC',
  'providers[].identifier': 'SENSITIVE',
  'providers[].name': 'SENSITIVE',
  'providers[].kind': 'SENSITIVE',
  'providers[].endpoint': 'SENSITIVE',
  'providers[].priority': 'SENSITIVE',
  'providers[].timeoutMs': 'SENSITIVE',
  'providers[].maxKeyLifetimeHours': 'SENSITIVE',
  'providers[].enabled': 'SENSITIVE',
  'providers[].hadApiKey': 'SENSITIVE',
  'providers[].apiKey': 'SECRET',
  'providers[].credential': 'SECRET',
  'providers[].credentials': 'SECRET',
  models: 'SENSITIVE',
  routing: 'SENSITIVE',
  rateLimits: 'SENSITIVE',
  'roles[].name': 'SENSITIVE',
  'roles[].description': 'SENSITIVE',
  'roles[].permissions': 'SENSITIVE',
  'settings.system': 'SENSITIVE',
  'settings.signIn.methods': 'SENSITIVE',
  'settings.signIn.require': 'SENSITIVE',
  'settings.mail.enabled': 'SENSITIVE',
  'settings.mail.host': 'SENSITIVE',
  'settings.mail.port': 'SENSITIVE',
  'settings.mail.security': 'SENSITIVE',
  'settings.mail.username': 'SENSITIVE',
  'settings.mail.from': 'SENSITIVE',
  'settings.mail.password': 'SECRET',
  'settings.mail.passwordCiphertext': 'SECRET',
};

/**
 * Values ClawRouter stores outside the configuration document, for completeness:
 * none of them is ever exported, and the protected ones are never returned either.
 */
export const STORED_VALUE_CLASSIFICATION: Record<string, ConfigClass> = {
  'provider API keys (provider_credentials)': 'SECRET',
  'mail server password (mail.server)': 'SECRET',
  'authenticator-app secrets (two-factor)': 'SECRET',
  'email sign-in codes': 'SECRET',
  'user passwords (stored as hashes)': 'SECRET',
  'API key secrets (stored as hashes; shown once at creation)': 'SECRET',
  'console session tokens (stored as hashes)': 'SECRET',
  'the secret key (CLAWROUTER_SECRET_KEY, data/secret.key)': 'SECURITY_CRITICAL',
  'the setup token (CLAWROUTER_SETUP_TOKEN, data/setup-token)': 'SECURITY_CRITICAL',
  'the TLS private key (the file CLAWROUTER_TLS_KEY_FILE names)': 'SECURITY_CRITICAL',
  'users, roles and permissions assigned to them': 'SENSITIVE',
  'request history and usage': 'SENSITIVE',
  'audit records': 'SENSITIVE',
};

/** `providers[3].endpoint` → `providers[].endpoint`. */
export const configurationPath = (path: string): string => path.replace(/\[\d+\]/g, '[]');

/** The class of a configuration document path (the longest classified prefix), or null when unknown. */
export function classifyConfigurationPath(path: string): ConfigClass | null {
  let p = configurationPath(path);
  for (;;) {
    const c = CONFIGURATION_FIELD_CLASSIFICATION[p];
    if (c) return c;
    const cut = Math.max(p.lastIndexOf('.'), p.lastIndexOf('[]') === p.length - 2 ? p.length - 2 : -1);
    if (cut <= 0) return null;
    p = p.slice(0, cut);
  }
}
