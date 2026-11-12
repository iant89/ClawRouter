export interface CookieOptions {
  maxAgeSeconds?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax';
  path?: string;
}

/** Parses a Cookie header. Invalid percent-encoding leaves the raw value. */
export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || out.has(name)) continue;
    const raw = part.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    try {
      out.set(name, decodeURIComponent(raw));
    } catch {
      out.set(name, raw);
    }
  }
  return out;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? '/'}`];
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  if (options.httpOnly ?? true) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Strict'}`);
  return parts.join('; ');
}
