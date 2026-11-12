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
  };

  if (issues.length) {
    const summary = issues.map((i) => `${i.key} ${i.message}`).join('; ');
    throw new AppError('VALIDATION_ERROR', `Invalid configuration: ${summary}`, {
      details: { issues: issues.map((i) => ({ path: i.key, message: i.message })) },
    });
  }
  return Object.freeze(config);
}
