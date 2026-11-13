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
