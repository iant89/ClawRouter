import { REDACTED, scrubSecrets } from '@clawrouter/core';
import { scrub } from './http.ts';

/**
 * Records the HTTP exchanges of one provider call, exactly as they went over the
 * wire, so a failure or a reply ClawRouter misreads can be reproduced later
 * (provider captures, owner request 2026-11-17). Nothing here decides whether a
 * recording is kept: the gateway does, after the request ends.
 *
 * Secrets never reach a recording: credential headers are replaced, the
 * provider's API key is cut out of every text (URL, bodies), and secret-shaped
 * strings are scrubbed as everywhere else.
 */

/** The largest body kept per request or response; the rest is counted, not stored. */
export const TAP_BODY_LIMIT = 256 * 1024;

export interface TappedBody {
  text: string;
  /** Bytes seen in total (more than `text` holds when truncated). */
  bytes: number;
  truncated: boolean;
}

export interface TappedExchange {
  startedAt: string;
  durationMs: number | null;
  request: { method: string; url: string; headers: Record<string, string>; body: TappedBody | null };
  response: { status: number; headers: Record<string, string>; body: TappedBody; complete: boolean } | null;
  /** Set when no response arrived (network error, timeout, cancelled) or the body stopped part-way. */
  transportError: string | null;
}

/** Header names whose values are credentials. */
const CREDENTIAL_HEADER = /authorization|api[-_]?key|token|secret|cookie|credential/i;

export function cleanHeaders(headers: HeadersInit | Headers | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers ?? {}).forEach((value, name) => {
    out[name] = CREDENTIAL_HEADER.test(name) ? REDACTED : scrubSecrets(value);
  });
  return out;
}

/** Query parameters that carry credentials (Google's native API accepts ?key=). */
const CREDENTIAL_PARAM = /^(key|api[-_]?key|access[-_]?token|token)$/i;

function cleanUrl(url: string, apiKey: string | null): string {
  try {
    const u = new URL(url);
    for (const name of [...u.searchParams.keys()]) if (CREDENTIAL_PARAM.test(name)) u.searchParams.set(name, REDACTED);
    return scrubSecrets(scrub(u.toString(), apiKey));
  } catch {
    return scrubSecrets(scrub(url, apiKey));
  }
}

/** Collects body bytes up to the limit; decodes once, when asked. */
class BodyCollector {
  private chunks: Uint8Array[] = [];
  private kept = 0;
  bytes = 0;

  add(chunk: Uint8Array) {
    this.bytes += chunk.byteLength;
    if (this.kept >= TAP_BODY_LIMIT) return;
    const room = TAP_BODY_LIMIT - this.kept;
    const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(part.slice());
    this.kept += part.byteLength;
  }

  read(apiKey: string | null): TappedBody {
    const all = new Uint8Array(this.kept);
    let at = 0;
    for (const c of this.chunks) {
      all.set(c, at);
      at += c.byteLength;
    }
    // `stream: true` leaves a multi-byte character cut by the limit out instead of garbling it.
    const text = new TextDecoder('utf-8', { fatal: false }).decode(all, { stream: this.bytes > this.kept });
    return { text: scrubSecrets(scrub(text, apiKey)), bytes: this.bytes, truncated: this.bytes > this.kept };
  }
}

function requestBody(body: BodyInit | null | undefined, apiKey: string | null): TappedBody | null {
  if (body === null || body === undefined) return null;
  if (typeof body !== 'string') return { text: '[a non-text body was sent]', bytes: 0, truncated: false };
  const bytes = new TextEncoder().encode(body).byteLength;
  const truncated = body.length > TAP_BODY_LIMIT;
  return { text: scrubSecrets(scrub(truncated ? body.slice(0, TAP_BODY_LIMIT) : body, apiKey)), bytes, truncated };
}

interface Pending {
  apiKey: string | null;
  exchange: Omit<TappedExchange, 'response' | 'durationMs'> & { durationMs: number | null };
  response: { status: number; headers: Record<string, string>; collector: BodyCollector; complete: boolean } | null;
  t0: number;
}

/**
 * One recording. `wrap` returns a fetch that behaves exactly like the one given
 * (same responses, same streaming and back-pressure) while copying what passes.
 */
export class ExchangeTap {
  private pending: Pending[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  wrap(inner: typeof fetch, apiKey: string | null): typeof fetch {
    const tapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const entry: Pending = {
        apiKey,
        t0: performance.now(),
        response: null,
        exchange: {
          startedAt: this.now().toISOString(),
          durationMs: null,
          request: { method: init?.method ?? 'GET', url: cleanUrl(url, apiKey), headers: cleanHeaders(init?.headers), body: requestBody(init?.body, apiKey) },
          transportError: null,
        },
      };
      this.pending.push(entry);
      const took = () => Math.round(performance.now() - entry.t0);
      let response: Response;
      try {
        response = await inner(input, init);
      } catch (error) {
        entry.exchange.durationMs = took();
        entry.exchange.transportError = scrubSecrets(scrub(error instanceof Error ? `${error.name}: ${error.message}` : String(error), apiKey)).slice(0, 500);
        throw error;
      }
      const collector = new BodyCollector();
      const record = { status: response.status, headers: cleanHeaders(response.headers), collector, complete: false };
      entry.response = record;
      // A Response can only be rebuilt with a status from 200 to 599; anything else passes through unrecorded.
      if (!response.body || response.status < 200 || response.status > 599) {
        record.complete = true;
        entry.exchange.durationMs = took();
        return response;
      }
      const copy = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          collector.add(chunk);
          controller.enqueue(chunk);
        },
        flush() {
          record.complete = true;
          entry.exchange.durationMs = took();
        },
      });
      // A body that stops part-way (cancelled, network error) never flushes: it is recorded as incomplete.
      const body = response.body.pipeThrough(copy);
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    return tapped as typeof fetch;
  }

  /** Marks bodies still open as incomplete (the call ended before reading them all). */
  exchanges(): TappedExchange[] {
    return this.pending.map((p) => ({
      ...p.exchange,
      durationMs: p.exchange.durationMs ?? Math.round(performance.now() - p.t0),
      response: p.response ? { status: p.response.status, headers: p.response.headers, body: p.response.collector.read(p.apiKey), complete: p.response.complete } : null,
    }));
  }

  get count(): number {
    return this.pending.length;
  }
}
