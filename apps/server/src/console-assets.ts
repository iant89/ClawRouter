import { join } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import type { HTMLBundle } from 'bun';
import { applySecurityHeaders, CONSOLE_CSP, type SecurityHeaderOptions } from '@clawrouter/api';

type Encoding = 'br' | 'gzip';

interface Asset {
  file: ReturnType<typeof Bun.file>;
  headers: Record<string, string>;
  /** Compressed bodies, made on first request and kept (the build never changes while running). */
  encoded: Partial<Record<Encoding, Uint8Array<ArrayBuffer>>>;
}

/** Text assets worth compressing (scripts, styles, the page). Images and fonts are already compressed. */
const COMPRESSIBLE = /^(text\/|application\/(javascript|json)|image\/svg)/;

/** brotli when the browser takes it (smaller), else gzip, else none. */
function negotiate(acceptEncoding: string | null): Encoding | null {
  const accepted = (acceptEncoding ?? '').toLowerCase();
  if (/\bbr\b/.test(accepted)) return 'br';
  if (/\bgzip\b/.test(accepted)) return 'gzip';
  return null;
}

async function encode(asset: Asset, encoding: Encoding): Promise<Uint8Array<ArrayBuffer>> {
  const cached = asset.encoded[encoding];
  if (cached) return cached;
  const raw = new Uint8Array(await asset.file.arrayBuffer());
  // Quality 9 / level 9: within a few percent of the maximum at a fraction of the time (~40 ms for the largest file).
  const body = encoding === 'br'
    ? new Uint8Array(brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }))
    : new Uint8Array(Bun.gzipSync(raw, { level: 9 }));
  asset.encoded[encoding] = body;
  return body;
}

/**
 * Serves the production console build ourselves instead of through Bun's HTML
 * route, so every response carries the console's security headers (CSP,
 * no framing, HSTS on HTTPS), which Bun's HTML routes cannot add.
 *
 * Hashed assets are cached for a year; `index.html` is revalidated every time,
 * and any path that is not an asset gets it (deep links into the single-page app).
 * Text is sent brotli- or gzip-compressed when the browser accepts it (phase 16:
 * the console's scripts shrink from ~1.2 MB to ~0.3 MB on the wire).
 * Returns null for a development bundle (no `files`): Bun's own route then serves
 * it with hot reload.
 */
export function createConsoleAssets(bundle: HTMLBundle, baseDir: string, options: SecurityHeaderOptions) {
  if (!bundle.files?.length) return null;
  const assets = new Map<string, Asset>();
  let index: Asset | null = null;
  for (const f of bundle.files) {
    const asset: Asset = { file: Bun.file(join(baseDir, f.path)), headers: { ...f.headers }, encoded: {} };
    if (f.loader === 'html') {
      index = asset;
      continue;
    }
    // Paths are relative to the bundle ("./index-abc123.js"); the page loads them from "/".
    assets.set(`/${f.path.replace(/^\.\//, '')}`, asset);
  }
  if (!index) return null;
  const page = index;

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    const path = new URL(request.url).pathname;
    const asset = assets.get(path);
    const chosen = asset ?? page;
    const headers = new Headers(chosen.headers);
    headers.set('cache-control', asset ? 'public, max-age=31536000, immutable' : 'no-cache');
    applySecurityHeaders(headers, CONSOLE_CSP, options);

    const compressible = COMPRESSIBLE.test(headers.get('content-type') ?? '');
    const encoding = compressible ? negotiate(request.headers.get('accept-encoding')) : null;
    if (compressible) headers.set('vary', 'Accept-Encoding');
    if (encoding) {
      headers.set('content-encoding', encoding);
      headers.delete('content-length');
      // Each encoding is a different representation, so it gets its own validator.
      const etag = headers.get('etag');
      // Bun's ETags are unquoted; quoted ones keep their quotes.
      if (etag) headers.set('etag', etag.endsWith('"') ? `${etag.slice(0, -1)}-${encoding}"` : `${etag}-${encoding}`);
    }
    if (request.headers.get('if-none-match') === headers.get('etag')) return new Response(null, { status: 304, headers });
    if (request.method === 'HEAD') return new Response(null, { headers });
    return new Response(encoding ? await encode(chosen, encoding) : chosen.file, { headers });
  };
}
