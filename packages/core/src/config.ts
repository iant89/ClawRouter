import { AppError } from './errors.ts';
import { LOG_LEVELS, type LogFormat, type LogLevel } from './logger.ts';

export const ENVIRONMENTS = ['development', 'test', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export interface Config {
  env: Environment;
  server: {
    host: string;
    port: number;
  };
  database: {
    /** File path, or `:memory:`. */
    path: string;
  };
  log: {
    level: LogLevel;
    format: LogFormat;
  };
  console: {
    /** Serve the web console from this process. The gateway works without it. */
    enabled: boolean;
  };
  health: {
    /** How often the server checks its own health in the background. */
    intervalSeconds: number;
  };
  providers: {
    /** How often enabled providers are health-checked. 0 turns background checks off. */
    healthIntervalSeconds: number;
  };
  secrets: {
    /** 32-byte key for encrypting stored credentials (base64 or hex). Never stored in the database. */
    key: string | null;
    /** File containing the key, as an alternative to `key`. */
    keyFile: string | null;
  };
  auth: {
    /** A session ends after this long without activity. */
    sessionIdleMinutes: number;
    /** A session ends this long after sign-in, regardless of activity. */
    sessionMaxHours: number;
    /** Mark the session cookie `Secure` (HTTPS only). Defaults to true in production. */
    cookieSecure: boolean;
    /**
     * Operator-chosen initial setup token. When unset, a random token is
     * generated at startup and written to a file next to the database.
     */
    setupToken: string | null;
  };
}

type Env = Record<string, string | undefined>;

interface Issue {
  key: string;
  message: string;
}

/**
 * Reads and validates configuration from environment variables (spec §3: runtime
 * validation at external boundaries). Collects every problem before failing so
 * operators can fix them in one pass.
 */
export function loadConfig(env: Env = process.env): Config {
  const issues: Issue[] = [];

  const str = (key: string, fallback: string): string => {
    const value = env[key]?.trim();
    return value ? value : fallback;
  };
  const oneOf = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const value = str(key, fallback);
    if ((allowed as readonly string[]).includes(value)) return value as T;
    issues.push({ key, message: `must be one of ${allowed.join(', ')} (got "${value}")` });
    return fallback;
  };
  const int = (key: string, fallback: number, min: number, max: number): number => {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      issues.push({ key, message: `must be an integer between ${min} and ${max} (got "${raw}")` });
      return fallback;
    }
    return value;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const raw = env[key]?.trim().toLowerCase();
    if (!raw) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    issues.push({ key, message: `must be a boolean (got "${raw}")` });
    return fallback;
  };

  const envName = oneOf('CLAWAPI_ENV', ENVIRONMENTS, env.NODE_ENV === 'production' ? 'production' : 'development');
  const config: Config = {
    env: envName,
    server: {
      // Loopback by default: nothing is exposed until an operator chooses to.
      host: str('CLAWAPI_HOST', '127.0.0.1'),
      port: int('CLAWAPI_PORT', 8080, 0, 65535),
    },
    database: {
      path: str('CLAWAPI_DATABASE_PATH', envName === 'test' ? ':memory:' : './data/clawapi.db'),
    },
    log: {
      level: oneOf('CLAWAPI_LOG_LEVEL', LOG_LEVELS, envName === 'development' ? 'debug' : 'info'),
      format: oneOf<LogFormat>('CLAWAPI_LOG_FORMAT', ['json', 'pretty'], envName === 'development' ? 'pretty' : 'json'),
    },
    console: {
      enabled: bool('CLAWAPI_CONSOLE_ENABLED', true),
    },
    health: {
      intervalSeconds: int('CLAWAPI_HEALTH_INTERVAL_SECONDS', 30, 5, 3600),
    },
    providers: {
      healthIntervalSeconds: int('CLAWAPI_PROVIDER_HEALTH_INTERVAL_SECONDS', 300, 0, 86_400),
    },
    secrets: {
      key: env.CLAWAPI_SECRET_KEY?.trim() || null,
      keyFile: env.CLAWAPI_SECRET_KEY_FILE?.trim() || null,
    },
    auth: {
      sessionIdleMinutes: int('CLAWAPI_SESSION_IDLE_MINUTES', 60, 1, 7 * 24 * 60),
      sessionMaxHours: int('CLAWAPI_SESSION_MAX_HOURS', 12, 1, 30 * 24),
      cookieSecure: bool('CLAWAPI_COOKIE_SECURE', envName === 'production'),
      setupToken: env.CLAWAPI_SETUP_TOKEN?.trim() || null,
    },
  };
  if (config.secrets.key && config.secrets.keyFile) {
    issues.push({ key: 'CLAWAPI_SECRET_KEY', message: 'set either CLAWAPI_SECRET_KEY or CLAWAPI_SECRET_KEY_FILE, not both' });
  }
  if (config.env === 'production' && !config.secrets.key && !config.secrets.keyFile) {
    issues.push({ key: 'CLAWAPI_SECRET_KEY', message: 'is required in production (or CLAWAPI_SECRET_KEY_FILE). Generate one with: openssl rand -base64 32' });
  }
  if (config.auth.setupToken !== null && config.auth.setupToken.length < 16) {
    issues.push({ key: 'CLAWAPI_SETUP_TOKEN', message: 'must be at least 16 characters' });
  }

  if (issues.length) {
    const summary = issues.map((i) => `${i.key} ${i.message}`).join('; ');
    throw new AppError('VALIDATION_ERROR', `Invalid configuration: ${summary}`, {
      details: { issues: issues.map((i) => ({ path: i.key, message: i.message })) },
    });
  }
    for (const section of Object.values(config)) if (typeof section === 'object') Object.freeze(section);
  return Object.freeze(config);
}
