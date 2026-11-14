import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import type { HTMLBundle } from 'bun';
import { createConsoleAssets } from '../src/console-assets.ts';

const dir = mkdtempSync(join(tmpdir(), 'clawrouter-assets-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const script = `console.log(${JSON.stringify('x'.repeat(20_000))});`;
writeFileSync(join(dir, 'index.html'), '<!doctype html><script src="/app-abc.js"></script>');
writeFileSync(join(dir, 'app-abc.js'), script);
writeFileSync(join(dir, 'logo-abc.png'), new Uint8Array([137, 80, 78, 71]));
writeFileSync(join(dir, 'style-abc.css'), 'body { color: red; }'.repeat(200));
const bundle = {
  index: './index.html',
  files: [
    { path: './index.html', loader: 'html', isEntry: true, headers: { etag: '"page"', 'content-type': 'text/html;charset=utf-8' } },
    { path: './app-abc.js', loader: 'js', isEntry: false, headers: { etag: '"app"', 'content-type': 'text/javascript;charset=utf-8' } },
    { path: './logo-abc.png', loader: 'file', isEntry: false, headers: { etag: 'logo', 'content-type': 'image/png' } },
    { path: './style-abc.css', loader: 'css', isEntry: false, headers: { etag: 'style', 'content-type': 'text/css;charset=utf-8' } },
  ],
} as unknown as HTMLBundle;
const serve = createConsoleAssets(bundle, dir, { https: false })!;
const get = (path: string, headers: Record<string, string> = {}) => serve(new Request(`http://localhost${path}`, { headers }));

describe('console assets (phase 16 compression)', () => {
  test('scripts are sent brotli- or gzip-compressed, with their own validators', async () => {
    const br = await get('/app-abc.js', { 'accept-encoding': 'gzip, deflate, br' });
    expect(br.headers.get('content-encoding')).toBe('br');
    expect(br.headers.get('vary')).toBe('Accept-Encoding');
    expect(br.headers.get('etag')).toBe('"app-br"');
    expect(br.headers.get('cache-control')).toContain('immutable');
    const body = new Uint8Array(await br.arrayBuffer());
    expect(body.length).toBeLessThan(script.length / 10);
    expect(new TextDecoder().decode(brotliDecompressSync(body))).toBe(script);

    const gz = await get('/app-abc.js', { 'accept-encoding': 'gzip' });
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await gz.arrayBuffer())))).toBe(script);

    const plain = await get('/app-abc.js');
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(await plain.text()).toBe(script);

    // Revalidation matches the representation asked for.
    expect((await get('/app-abc.js', { 'accept-encoding': 'br', 'if-none-match': '"app-br"' })).status).toBe(304);
    expect((await get('/app-abc.js', { 'accept-encoding': 'gzip', 'if-none-match': '"app-br"' })).status).toBe(200);
    // Bun's own ETags come without quotes; each encoding still gets its own.
    expect((await get('/style-abc.css', { 'accept-encoding': 'br' })).headers.get('etag')).toBe('style-br');
    expect((await get('/logo-abc.png')).headers.get('etag')).toBe('logo');
  });

  test('the page is compressed and still carries the security headers; images are left alone', async () => {
    const page = await get('/requests?page=2', { 'accept-encoding': 'br' });
    expect(page.headers.get('content-encoding')).toBe('br');
    expect(page.headers.get('cache-control')).toBe('no-cache');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
    const png = await get('/logo-abc.png', { 'accept-encoding': 'br' });
    expect(png.headers.get('content-encoding')).toBeNull();
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect((await serve(new Request('http://localhost/app-abc.js', { method: 'POST' }))).status).toBe(405);
    // A page file from an older build: 404, so the console can tell the user to reload.
    expect((await get('/SettingsPage-old123.js')).status).toBe(404);
    expect((await get('/settings')).status).toBe(200);
  });
});
