/** Keys whose values are never written to logs, audit metadata or responses. */
const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|credential|private[-_]?key|session/i;
export const REDACTED = '[REDACTED]';

/**
 * Returns a deep copy of `value` with sensitive keys replaced by `[REDACTED]`.
 * Handles cycles, Errors and depth limits so it is safe to call on arbitrary input.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    const out: Record<string, unknown> = { name: value.name, message: value.message };
    if ('code' in value) out.code = (value as { code: unknown }).code;
    if (value.stack) out.stack = value.stack;
    if (value.cause !== undefined) out.cause = redact(value.cause, depth + 1, seen);
    return out;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen));
  if (value instanceof Headers) return redact(Object.fromEntries(value.entries()), depth + 1, seen);

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(item, depth + 1, seen);
  }
  return out;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}
