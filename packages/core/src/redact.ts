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

export const REDACTED = '[REDACTED]';

/**
 * Key names whose values are never written to logs, audit metadata or responses:
 * passwords, secrets, tokens, cookies, sessions, API keys, credentials, private
 * keys, signatures of signed URLs, recovery codes, connection strings. `pass` must
 * end the word ("pass", "smtpPass", "password"; not "passage").
 */
const SENSITIVE_KEY = /pass(word|wd|phrase)?(?![a-z])|ciphertext|secret|token|authori[sz]ation|^auth$|cookie|session|api[-_]?key|credential|private[-_]?key|jwt|bearer|csrf|recovery[-_]?codes?|connection[-_]?string|^dsn$|^sig(nature)?$|^x-goog-api-key$/i;
/** Names that look sensitive but hold counts or settings (token counts, limits): left out before the test above. */
const NOT_SENSITIVE = /secure_?cookies?|tokens|(token|session)[a-z_]*?(count|limit|usage|estimate|seconds|minutes|hours|days|timeout|lifetime|enabled)s?|sessions|bypass/gi;

/** True when a field with this name must never be written out. */
export function isSensitiveKey(key: string): boolean {
  const name = key.replace(NOT_SENSITIVE, '');
  return name.length > 0 && SENSITIVE_KEY.test(name);
}

/** Header names whose values are credentials, in header-like text ("Cookie: a=b"). Authorization is handled below. */
const CREDENTIAL_HEADERS = 'cookie|set-cookie|x-api-key|x-goog-api-key|api-key|x-auth-token|x-access-token|x-csrf-token|x-clawrouter-csrf|x-setup-token|x-amz-security-token';
/** Key names that, as `name=value` or `"name": "value"` in text, carry a secret. */
const TEXT_KEYS = 'pass(?:word|wd|phrase)?|secret|client[-_]?secret|[a-z_]*token|api[-_]?key|access[-_]?key|private[-_]?key|credentials?|authorization|cookie|session(?:[-_]?id)?|clawrouter_session|sid|connect\\.sid|jwt';
/** Authorization schemes: the scheme stays readable, the credential after it does not. */
const SCHEMES = 'Bearer|Basic|Token|Bot|Digest|ApiKey|Api-Key|SSWS|Splunk|GenieKey';

/**
 * Secret-shaped strings, scrubbed wherever they appear (defence in depth: a key
 * can end up inside an error message, a URL, a stack trace or a tool's arguments,
 * where key names do not help). Order matters: whole blocks first, then shapes,
 * then the context around values.
 */
const SECRET_PATTERNS: [RegExp, string][] = [
  // PEM private keys (RSA, EC, OpenSSH, PKCS#8, encrypted), whole block; then one cut off before its end.
  [/-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g, `-----BEGIN $1PRIVATE KEY-----${REDACTED}-----END $1PRIVATE KEY-----`],
  [/-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----(?![[]REDACTED)[\s\S]*/g, `-----BEGIN $1PRIVATE KEY-----${REDACTED}`],
  // ClawRouter API keys: keep the public prefix, drop the secret part.
  [/\b(crk_[0-9a-f]{8})_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, `$1_${REDACTED}`],
  // JSON Web Tokens (header.payload.signature, both JSON parts start with "eyJ").
  [/\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, `[REDACTED JWT]`],
  // OpenAI / Anthropic / OpenRouter style keys (sk-…, sk-ant-…, sk-proj-…, sk-or-v1-…).
  [/\bsk-[A-Za-z0-9_-]{16,}/g, `sk-${REDACTED}`],
  // Groq API keys (gsk_…).
  [/\bgsk_[A-Za-z0-9]{20,}/g, `gsk_${REDACTED}`],
  // Google API keys and OAuth access tokens.
  [/\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, `AIza${REDACTED}`],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, `ya29.${REDACTED}`],
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_), Slack tokens, AWS access key ids.
  [/\b(gh[pousr]_)[A-Za-z0-9]{30,}/g, `$1${REDACTED}`],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, `github_pat_${REDACTED}`],
  [/\b(xox[abposr]-)[A-Za-z0-9-]{10,}/g, `$1${REDACTED}`],
  [/\b(A(?:KIA|SIA))[0-9A-Z]{16}\b/g, `$1${REDACTED}`],
  // SMTP authentication lines (AUTH PLAIN <base64>, a LOGIN answer is caught by its key names elsewhere).
  [/\bAUTH\s+(PLAIN|LOGIN|XOAUTH2|CRAM-MD5)\s+[A-Za-z0-9+/=]{4,}/g, `AUTH $1 ${REDACTED}`],
  // Passwords in URLs: scheme://user:password@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/?#]*):[^\s@/?#]+@/gi, `$1:${REDACTED}@`],
  // Authorization with a scheme, in header-like text: "Bearer abc…".
  [new RegExp(`\\b(${SCHEMES})\\s+(?!\\[REDACTED)[A-Za-z0-9._~+/=:-]{8,}`, 'gi'), `$1 ${REDACTED}`],
  // Authorization without a known scheme: "Authorization: abc…".
  [new RegExp(`\\b((?:proxy-)?authorization\\s*:\\s*)(?!(?:${SCHEMES})\\s)(?!\\[REDACTED)[^\\s,;"']+`, 'gi'), `$1${REDACTED}`],
  // Credential headers in text: "Cookie: clawrouter_session=…; other=…" (to the end of the line).
  [new RegExp(`(^|[^A-Za-z0-9-])(${CREDENTIAL_HEADERS})(\\s*:\\s*)(?!\\[REDACTED)[^\\r\\n"]+`, 'gim'), `$1$2$3${REDACTED}`],
  // "password": "…" inside JSON text (tool arguments, provider bodies, serialized objects).
  [new RegExp(`("[A-Za-z0-9_-]*?(?:${TEXT_KEYS})[A-Za-z0-9_-]*?"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi'), `$1"${REDACTED}"`],
  // The same inside JSON that was itself put in a JSON string (\"password\":\"…\").
  [new RegExp(`(\\\\"[A-Za-z0-9_-]*?(?:${TEXT_KEYS})[A-Za-z0-9_-]*?\\\\"\\s*:\\s*)\\\\"(?:[^"\\\\]|\\\\[^"])*\\\\"`, 'gi'), `$1\\"${REDACTED}\\"`],
  // password=…, ?key=…, &access_token=…, X-Amz-Signature=… in URLs, form bodies, cookies and messages.
  [new RegExp(`(^|[^A-Za-z0-9_.-])((?:${TEXT_KEYS}|key|code|sig|[A-Za-z-]*signature)=)(?!\\[REDACTED)[^&#\\s"'\\\\;,]+`, 'gim'), `$1$2${REDACTED}`],
];

/** Replaces secret-shaped substrings (API keys, tokens, private keys, passwords in URLs, credential headers) in a string. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Returns a deep copy of `value` with sensitive keys replaced by `[REDACTED]` and
 * secret-shaped strings scrubbed. Handles cycles, Errors (message, stack, cause,
 * aggregated errors), Headers, URLs, Maps and depth limits, so it is safe to call
 * on arbitrary input.
 */
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
    if (value instanceof AggregateError) out.errors = redact(value.errors, depth + 1, seen);
    return out;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return scrubSecrets(value.toString());
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen));
  if (value instanceof Headers) return redact(Object.fromEntries(value.entries()), depth + 1, seen);
  if (value instanceof Map) return redact(Object.fromEntries(value.entries()), depth + 1, seen);

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(item, depth + 1, seen);
  }
  return out;
}
