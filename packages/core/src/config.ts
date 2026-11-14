import { dirname, join } from 'node:path';
import { parseTrustedProxies } from './client-address.ts';
import { AppError } from './errors.ts';
import { LOG_LEVELS, type LogFormat, type LogLevel } from './logger.ts';

export const ENVIRONMENTS = ['development', 'test', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export interface Config {
  env: Environment;
  server: {
    host: string;
    port: number;
    /** Reverse proxies whose X-Forwarded-For is believed (addresses or CIDR ranges). Empty: none. */
    trustedProxies: string[];
    /** On SIGTERM/SIGINT, how long in-flight gateway requests may take to finish before they are cut off. */
    shutdownGraceSeconds: number;
    /** Let a second process listen on the same port (Linux), for restarts without downtime. */
    reusePort: boolean;
    /** Serve HTTPS directly (PEM files). Null: plain HTTP, normally behind a TLS-terminating proxy. */
    tls: { certFile: string; keyFile: string } | null;
  };
  database: {
    /** File path, or `:memory:`. */
    path: string;
    /** `auto`: apply pending migrations at startup. `manual`: refuse to start until `bun run migrate`. */
    migrations: 'auto' | 'manual';
    /** Copy the database to `backupDir` before applying migrations to it. */
    backupBeforeMigrate: boolean;
    /** Where automatic and `bun run backup` copies go (default: `backups/` next to the database). */
    backupDir: string;
    /** Hours between automatic backups while running (0: none). Default 24 in production. */
    backupIntervalHours: number;
    /** Automatic backups kept (each kind: scheduled, pre-migrate); older ones are removed. */
    backupKeep: number;
  };
  log: {
    level: LogLevel;
    format: LogFormat;
    /** Recent log records kept in memory for the Logs page (0 turns it off). */
    bufferSize: number;
  };
  console: {
    /** Serve the web console from this process. The gateway works without it. */
    enabled: boolean;
  };
  health: {
    /** How often the server checks its own health in the background. */
    intervalSeconds: number;
    /** Days of health history to keep (0 keeps it forever). */
    historyDays: number;
  };
  requests: {
    /** Days to keep gateway request history (0 keeps it forever). */
    retentionDays: number;
    /** Days to keep hourly usage records (0 keeps them forever). */
    usageRetentionDays: number;
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

  const envName = oneOf('CLAWROUTER_ENV', ENVIRONMENTS, env.NODE_ENV === 'production' ? 'production' : 'development');
  const dbPath = str('CLAWROUTER_DATABASE_PATH', envName === 'test' ? ':memory:' : './data/clawrouter.db');
  const config: Config = {
    env: envName,
    server: {
      // Loopback by default: nothing is exposed until an operator chooses to.
      host: str('CLAWROUTER_HOST', '127.0.0.1'),
      port: int('CLAWROUTER_PORT', 8080, 0, 65535),
      trustedProxies: [],
      shutdownGraceSeconds: int('CLAWROUTER_SHUTDOWN_GRACE_SECONDS', 30, 0, 600),
      reusePort: bool('CLAWROUTER_REUSE_PORT', false),
      tls: null,
    },
    database: {
      path: dbPath,
      migrations: oneOf('CLAWROUTER_MIGRATIONS', ['auto', 'manual'] as const, 'auto'),
      backupBeforeMigrate: bool('CLAWROUTER_BACKUP_BEFORE_MIGRATE', dbPath !== ':memory:'),
      backupDir: str('CLAWROUTER_BACKUP_DIR', dbPath === ':memory:' ? './data/backups' : join(dirname(dbPath), 'backups')),
      backupIntervalHours: int('CLAWROUTER_BACKUP_INTERVAL_HOURS', envName === 'production' && dbPath !== ':memory:' ? 24 : 0, 0, 24 * 30),
      backupKeep: int('CLAWROUTER_BACKUP_KEEP', 7, 1, 1000),
    },
    log: {
      level: oneOf('CLAWROUTER_LOG_LEVEL', LOG_LEVELS, envName === 'development' ? 'debug' : 'info'),
      format: oneOf<LogFormat>('CLAWROUTER_LOG_FORMAT', ['json', 'pretty'], envName === 'development' ? 'pretty' : 'json'),
      bufferSize: int('CLAWROUTER_LOG_BUFFER_SIZE', 5000, 0, 100_000),
    },
    console: {
      enabled: bool('CLAWROUTER_CONSOLE_ENABLED', true),
    },
    health: {
      intervalSeconds: int('CLAWROUTER_HEALTH_INTERVAL_SECONDS', 30, 5, 3600),
      historyDays: int('CLAWROUTER_HEALTH_HISTORY_DAYS', 7, 0, 365),
    },
    requests: {
      retentionDays: int('CLAWROUTER_REQUEST_RETENTION_DAYS', 30, 0, 3650),
      usageRetentionDays: int('CLAWROUTER_USAGE_RETENTION_DAYS', 400, 0, 3650),
    },
    providers: {
      healthIntervalSeconds: int('CLAWROUTER_PROVIDER_HEALTH_INTERVAL_SECONDS', 300, 0, 86_400),
    },
    secrets: {
      key: env.CLAWROUTER_SECRET_KEY?.trim() || null,
      keyFile: env.CLAWROUTER_SECRET_KEY_FILE?.trim() || null,
    },
    auth: {
      sessionIdleMinutes: int('CLAWROUTER_SESSION_IDLE_MINUTES', 60, 1, 7 * 24 * 60),
      sessionMaxHours: int('CLAWROUTER_SESSION_MAX_HOURS', 12, 1, 30 * 24),
      cookieSecure: bool('CLAWROUTER_COOKIE_SECURE', envName === 'production'),
      setupToken: env.CLAWROUTER_SETUP_TOKEN?.trim() || null,
    },
  };
  const proxies = parseTrustedProxies(env.CLAWROUTER_TRUSTED_PROXIES);
  if (proxies.invalid.length) issues.push({ key: 'CLAWROUTER_TRUSTED_PROXIES', message: `must be IP addresses or CIDR ranges, comma-separated (invalid: ${proxies.invalid.join(', ')})` });
  config.server.trustedProxies = [...proxies.proxies.entries];
  if (config.secrets.key && config.secrets.keyFile) {
    issues.push({ key: 'CLAWROUTER_SECRET_KEY', message: 'set either CLAWROUTER_SECRET_KEY or CLAWROUTER_SECRET_KEY_FILE, not both' });
  }
  if (config.env === 'production' && !config.secrets.key && !config.secrets.keyFile) {
    issues.push({ key: 'CLAWROUTER_SECRET_KEY', message: 'is required in production (or CLAWROUTER_SECRET_KEY_FILE). Generate one with: openssl rand -base64 32' });
  }
  const certFile = env.CLAWROUTER_TLS_CERT_FILE?.trim();
  const keyFile = env.CLAWROUTER_TLS_KEY_FILE?.trim();
  if (certFile && keyFile) config.server.tls = { certFile, keyFile };
  else if (certFile || keyFile) issues.push({ key: certFile ? 'CLAWROUTER_TLS_KEY_FILE' : 'CLAWROUTER_TLS_CERT_FILE', message: 'is needed too: set both CLAWROUTER_TLS_CERT_FILE and CLAWROUTER_TLS_KEY_FILE, or neither' });
  // Cookies follow the transport: served over HTTPS directly, they are Secure unless told otherwise.
  if (config.server.tls && env.CLAWROUTER_COOKIE_SECURE === undefined) config.auth.cookieSecure = true;
  if (config.auth.setupToken !== null && config.auth.setupToken.length < 16) {
    issues.push({ key: 'CLAWROUTER_SETUP_TOKEN', message: 'must be at least 16 characters' });
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
