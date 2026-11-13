import { join } from 'node:path';
import type { HTMLBundle } from 'bun';
import { applySecurityHeaders, CONSOLE_CSP, type SecurityHeaderOptions } from '@clawrouter/api';

interface Asset {
  file: ReturnType<typeof Bun.file>;
  headers: Record<string, string>;
}

/**
 * Serves the production console build ourselves instead of through Bun's HTML
 * route, so every response carries the console's security headers (CSP,
 * no framing, HSTS on HTTPS), which Bun's HTML routes cannot add.
 *
 * Hashed assets are cached for a year; `index.html` is revalidated every time,
 * and any path that is not an asset gets it (deep links into the single-page app).
 * Returns null for a development bundle (no `files`): Bun's own route then serves
 * it with hot reload.
 */
export function createConsoleAssets(bundle: HTMLBundle, baseDir: string, options: SecurityHeaderOptions) {
  if (!bundle.files?.length) return null;
  const assets = new Map<string, Asset>();
  let index: Asset | null = null;
  for (const f of bundle.files) {
    const asset: Asset = { file: Bun.file(join(baseDir, f.path)), headers: { ...f.headers } };
    if (f.loader === 'html') {
      index = asset;
      continue;
    }
    // Paths are relative to the bundle ("./index-abc123.js"); the page loads them from "/".
    assets.set(`/${f.path.replace(/^\.\//, '')}`, asset);
  }
  if (!index) return null;
  const page = index;

  return (request: Request): Response => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    const path = new URL(request.url).pathname;
    const asset = assets.get(path);
    const chosen = asset ?? page;
    const headers = new Headers(chosen.headers);
    headers.set('cache-control', asset ? 'public, max-age=31536000, immutable' : 'no-cache');
    applySecurityHeaders(headers, CONSOLE_CSP, options);
    if (request.headers.get('if-none-match') === headers.get('etag')) return new Response(null, { status: 304, headers });
    return new Response(request.method === 'HEAD' ? null : chosen.file, { headers });
  };
}
