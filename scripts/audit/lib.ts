/**
 * Shared pieces of the outside-in audit (`bun run audit`): an HTTP client with a
 * cookie jar and the console's CSRF conventions, the result recorder, and small
 * helpers. The audit talks to a real production build only through HTTP, WebSocket
 * and the command-line tools, as an attacker or an operator would.
 */
import { createHmac } from 'node:crypto';

export type Outcome = 'pass' | 'fail' | 'note';
export interface Result {
  id: string;
  area: string;
  claim: string;
  outcome: Outcome;
  detail: string;
}

export class Recorder {
  readonly results: Result[] = [];
  check(id: string, area: string, claim: string, ok: boolean, detail = '') {
    this.add({ id, area, claim, outcome: ok ? 'pass' : 'fail', detail });
  }
  note(id: string, area: string, claim: string, detail: string) {
    this.add({ id, area, claim, outcome: 'note', detail });
  }
  /** Records a check that threw instead of failing the whole run. */
  error(id: string, area: string, error: unknown) {
    this.add({ id, area, claim: 'section ran to the end', outcome: 'fail', detail: error instanceof Error ? error.message : String(error) });
  }
  private add(r: Result) {
    this.results.push(r);
    const tag = r.outcome === 'pass' ? 'PASS' : r.outcome === 'fail' ? 'FAIL' : 'NOTE';
    console.log(`${tag} ${r.id.padEnd(6)} ${r.area}: ${r.claim}${r.detail ? ` — ${r.detail.slice(0, 220)}` : ''}`);
  }
}

type CallInit = RequestInit & { json?: unknown; csrf?: boolean; origin?: string | null };

export class Client {
  readonly cookies = new Map<string, string>();
  constructor(readonly base: string, readonly name = 'anonymous') {}

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** The session cookie's value, whatever its name (`__Host-` prefix on HTTPS). */
  session() {
    for (const [k, v] of this.cookies) if (k.endsWith('clawrouter_session')) return v;
    return undefined;
  }

  async raw(path: string, init: CallInit = {}) {
    const headers = new Headers(init.headers);
    const method = (init.method ?? (init.json !== undefined ? 'POST' : 'GET')).toUpperCase();
    if (this.cookies.size && !headers.has('cookie')) headers.set('cookie', this.cookieHeader());
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (unsafe && init.csrf !== false && !headers.has('x-clawrouter-csrf')) headers.set('x-clawrouter-csrf', '1');
    if (unsafe && init.origin !== null && !headers.has('origin')) headers.set('origin', init.origin ?? new URL(this.base).origin);
    let body = init.body;
    if (init.json !== undefined) {
      body = JSON.stringify(init.json);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }
    const res = await fetch(this.base + path, { ...init, method, headers, body, redirect: 'manual', tls: { rejectUnauthorized: false } } as RequestInit);
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0] ?? '';
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (v === '' || /max-age=0|expires=thu, 01 jan 1970/i.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    return res;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async call(path: string, init: CallInit = {}): Promise<{ status: number; body: any; data: any; res: Response; text: string }> {
    const res = await this.raw(path, init);
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, body, data: (body as { data?: unknown } | null)?.data, res, text };
  }

  login(username: string, password: string) {
    return this.call('/api/auth/login', { json: { username, password } });
  }
}

/** A list from an API answer that is either an array or a page (`{ items }`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const items = (data: any): any[] => (Array.isArray(data) ? data : data?.items ?? data?.sessions ?? data?.notifications ?? []);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** RFC 6238 code for a base32 secret at a 30-second step. */
export function totp(secret: string, step: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
export const step = () => Math.floor(Date.now() / 30_000);

/** Calls /v1 with an API key. */
export const v1 = (base: string, path: string, key: string | null, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    tls: { rejectUnauthorized: false },
  } as RequestInit);

export const chat = (model: string, content = 'Hello') => ({ model, messages: [{ role: 'user', content }] });
