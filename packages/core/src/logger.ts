import { redact } from './redact.ts';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFormat = 'json' | 'pretty';
export type LogFields = Record<string, unknown>;

export interface LogRecord {
  time: string;
  level: LogLevel;
  msg: string;
  component?: string;
  [field: string]: unknown;
}

export type LogSink = (record: LogRecord, line: string) => void;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  fatal(msg: string, fields?: LogFields): void;
  /** A logger that adds `bindings` (e.g. `{ component: 'database' }`) to every record. */
  child(bindings: LogFields): Logger;
  isLevelEnabled(level: LogLevel): boolean;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  /** Where formatted lines go. Defaults to stdout (stderr for warn and above). */
  sink?: LogSink;
  bindings?: LogFields;
  now?: () => Date;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const COLOR: Record<LogLevel, string> = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', fatal: '\x1b[35m' };

function formatPretty(record: LogRecord): string {
  const { time, level, msg, component, ...rest } = record;
  const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
  const scope = component ? ` \x1b[90m[${component}]\x1b[0m` : '';
  return `\x1b[90m${time.slice(11, 23)}\x1b[0m ${COLOR[level]}${level.toUpperCase().padEnd(5)}\x1b[0m${scope} ${msg}${extra}`;
}

const defaultSink: LogSink = (record, line) => {
  if (RANK[record.level] >= RANK.warn) process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
};

/**
 * Structured logger. Every record passes through `redact`, so fields named
 * like secrets (password, token, apiKey, authorization, ...) are never written.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const format = options.format ?? 'json';
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());
  const bindings = options.bindings ?? {};
  const threshold = RANK[level];

  const write = (lvl: LogLevel, msg: string, fields?: LogFields) => {
    if (RANK[lvl] < threshold) return;
    const safe = redact({ ...bindings, ...fields }) as LogFields;
    const record: LogRecord = { time: now().toISOString(), level: lvl, msg, ...safe };
    const line = format === 'pretty' ? formatPretty(record) : JSON.stringify(record);
    sink(record, line);
  };

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    fatal: (msg, fields) => write('fatal', msg, fields),
    child: (extra) => createLogger({ level, format, sink, now, bindings: { ...bindings, ...extra } }),
    isLevelEnabled: (lvl) => RANK[lvl] >= threshold,
  };
}

/** A logger that discards everything (useful in tests). */
export const silentLogger: Logger = createLogger({ level: 'fatal', sink: () => {} });
