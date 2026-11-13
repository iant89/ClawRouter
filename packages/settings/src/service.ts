import { errors, type Config, type EventBus, type Logger } from '@clawrouter/core';
import type { AuditService } from '@clawrouter/audit';
import type { SettingsRepository } from '@clawrouter/database';
import { isSettingKey, SETTING_DEFINITIONS, SETTING_KEYS, type SettingInfo, type SettingKey } from '@clawrouter/shared';

/** Stored under this prefix in the `settings` table. */
const PREFIX = 'system.';
/** `sessionIdleMinutes` is stored as `system.session_idle_minutes` (the table allows lower-case keys only). */
const storageKey = (key: SettingKey) => PREFIX + key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const BY_STORAGE_KEY = new Map(SETTING_KEYS.map((k) => [storageKey(k), k]));

export interface SettingsActor {
  id: string;
  username: string;
}

export type SettingsService = ReturnType<typeof createSettingsService>;

const inRange = (key: SettingKey, value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= SETTING_DEFINITIONS[key].min && value <= SETTING_DEFINITIONS[key].max;

/**
 * System and security settings. Values come from the console when changed there,
 * otherwise from the environment (`defaults`). Services read them at use time
 * through `get`, so changes take effect without a restart.
 */
export function createSettingsService(options: {
  repo: SettingsRepository;
  /** Defaults from the environment or built-in values. */
  defaults: Record<SettingKey, number>;
  audit: AuditService;
  events?: EventBus;
  log?: Logger;
}) {
  const { repo, defaults, audit, events, log } = options;
  const stored = new Map<SettingKey, { value: number; updatedAt: string }>();
  for (const s of repo.list()) {
    const key = BY_STORAGE_KEY.get(s.key);
    if (!key) continue;
    // A value outside today's range (e.g. hand-edited) is ignored rather than trusted.
    if (inRange(key, s.value)) stored.set(key, { value: s.value, updatedAt: s.updatedAt });
    else log?.warn('ignoring an invalid stored setting', { component: 'settings', key });
  }

  const get = (key: SettingKey): number => stored.get(key)?.value ?? defaults[key];

  const list = (): SettingInfo[] =>
    SETTING_KEYS.map((key) => {
      const d = SETTING_DEFINITIONS[key];
      return {
        key, group: d.group, label: d.label, description: d.description, unit: d.unit, min: d.min, max: d.max, env: d.env,
        value: get(key), defaultValue: defaults[key], overridden: stored.has(key), updatedAt: stored.get(key)?.updatedAt ?? null,
      };
    });

  return {
    get,
    list,

    /** Changes several settings at once (all or nothing). `null` resets one to its default. */
    update(actor: SettingsActor, values: Record<string, unknown>, client: { ip: string | null; requestId?: string | null }): SettingInfo[] {
      const issues: { path: string; message: string }[] = [];
      for (const [key, value] of Object.entries(values)) {
        if (!isSettingKey(key)) issues.push({ path: `values.${key}`, message: 'is not a setting' });
        else if (value !== null && !inRange(key, value)) {
          const d = SETTING_DEFINITIONS[key];
          issues.push({ path: `values.${key}`, message: `must be a whole number from ${d.min} to ${d.max}` });
        }
      }
      if (issues.length) throw errors.validation(issues);

      const changes: Record<string, { before: number; after: number }> = {};
      for (const [key, value] of Object.entries(values) as [SettingKey, number | null][]) {
        const before = get(key);
        if (value === null) {
          if (repo.delete(storageKey(key))) stored.delete(key);
        } else if (value !== stored.get(key)?.value) {
          const saved = repo.set(storageKey(key), value);
          stored.set(key, { value, updatedAt: saved.updatedAt });
        }
        if (get(key) !== before) changes[key] = { before, after: get(key) };
      }

      if (Object.keys(changes).length) {
        audit.record({
          action: 'SETTINGS_CHANGED', result: 'SUCCESS', resource: 'settings',
          actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null, metadata: { changes },
        });
        for (const key of Object.keys(changes)) events?.emit('settings.changed', { key });
        log?.info('settings changed', { component: 'settings', keys: Object.keys(changes) });
      }
      return list();
    },
  };
}

/** Setting defaults from the server configuration (environment variables) or built-in values. */
export function settingDefaults(config: Pick<Config, 'auth' | 'requests' | 'health'>): Record<SettingKey, number> {
  return {
    sessionIdleMinutes: config.auth.sessionIdleMinutes,
    sessionMaxHours: config.auth.sessionMaxHours,
    signInMaxFailures: 10,
    requestRetentionDays: config.requests.retentionDays,
    usageRetentionDays: config.requests.usageRetentionDays,
    healthHistoryDays: config.health.historyDays,
  };
}
