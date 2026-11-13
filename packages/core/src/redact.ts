/** Keys whose values are never written to logs, audit metadata or responses. */
const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|credential|private[-_]?key/i;
export const REDACTED = '[REDACTED]';

/**
 * Returns a deep copy of `value` with sensitive keys replaced by `[REDACTED]`.
 * Handles cycles, Errors and depth limits so it is safe to call on arbitrary input.
 */
/**
 * Secret-shaped strings, scrubbed wherever they appear (defence in depth: a key
 * can end up inside an error message or a URL, where key names do not help).
 */
const SECRET_PATTERNS: [RegExp, string][] = [
  // ClawRouter API keys: keep the public prefix, drop the secret part.
  [/\b(crk_[0-9a-f]{8})_[A-Za-z0-9_-]{43}\b/g, `$1_${REDACTED}`],
  // OpenAI / Anthropic style keys (sk-…, sk-ant-…, sk-proj-…).
  [/\bsk-[A-Za-z0-9_-]{16,}/g, `sk-${REDACTED}`],
  // Google API keys.
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, `AIza${REDACTED}`],
  // Bearer tokens in header-like text.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
];

/** Replaces secret-shaped substrings (API keys, bearer tokens) in a string. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubSecrets(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    const out: Record<string, unknown> = { name: value.name, message: scrubSecrets(value.message) };
    if ('code' in value) out.code = (value as { code: unknown }).code;
    if (value.stack) out.stack = scrubSecrets(value.stack);
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
