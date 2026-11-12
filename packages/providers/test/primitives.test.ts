import { describe, expect, test } from 'bun:test';
import { checkEndpoint, parseSse, providerFetch, ProviderCallError, scrub } from '../src/index.ts';

describe('endpoint policy', () => {
  test.each([
    ['https://api.openai.com/v1/', 'https://api.openai.com/v1'],
    ['http://localhost:11434/v1', 'http://localhost:11434/v1'],
    ['http://127.0.0.1:8000', 'http://127.0.0.1:8000'],
    ['http://192.168.1.20:1234/v1', 'http://192.168.1.20:1234/v1'],
    ['http://ollama:11434/v1', 'http://ollama:11434/v1'],
  ])('accepts %s', (input, normalized) => {
    expect(checkEndpoint(input)).toEqual({ url: normalized, issues: [] });
  });

  test.each([
    ['http://api.example.com/v1', 'https'],
    ['ftp://example.com', 'http or https'],
    ['https://user:pw@example.com', 'credentials'],
    ['https://example.com/v1?key=abc', 'query string'],
    ['http://169.254.169.254/latest', 'metadata'],
    ['https://metadata.google.internal', 'metadata'],
    ['not a url', 'valid URL'],
  ])('rejects %s', (input, message) => {
    const { url, issues } = checkEndpoint(input);
    expect(url).toBeNull();
    expect(issues[0]!.message).toContain(message);
  });
});

describe('SSE parser', () => {
  const stream = (chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    });

  test('handles events split across chunks, CRLF, comments and multi-line data', async () => {
    const events = [];
    for await (const e of parseSse(stream(['event: a\r\nda', 'ta: 1\r\n\r\n: keep-alive\n\ndata: x\ndata: y\n\n', 'data: tail']))) events.push(e);
    expect(events).toEqual([{ event: 'a', data: '1' }, { event: null, data: 'x\ny' }, { event: null, data: 'tail' }]);
  });
});

describe('providerFetch', () => {
  const ctx = (fetchImpl: typeof fetch, extra = {}) => ({ endpoint: 'https://x', apiKey: 'sk-secret-key-123', timeoutMs: 200, fetch: fetchImpl, ...extra });
  const fake = (res: Response | (() => Promise<Response>)) => (async () => (typeof res === 'function' ? res() : res)) as unknown as typeof fetch;

  test('maps HTTP errors and scrubs the key from provider messages', async () => {
    const error = await providerFetch(ctx(fake(Response.json({ error: { message: 'bad key sk-secret-key-123' } }, { status: 401 }))), 'https://x', {}).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderCallError);
    expect(error.failure).toBe('auth');
    expect(error.message).toContain('[REDACTED]');
    expect(error.message).not.toContain('sk-secret-key-123');
  });

  test('refuses redirects', async () => {
    const error = await providerFetch(ctx(fake(new Response(null, { status: 307, headers: { location: 'https://evil' } }))), 'https://x', {}).catch((e) => e);
    expect(error.failure).toBe('invalid_response');
    expect(error.message).toContain('redirect');
  });

  test('times out', async () => {
    const hang = ((_: unknown, init?: RequestInit) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const error = await providerFetch(ctx(hang, { timeoutMs: 30 }), 'https://x', {}).catch((e) => e);
    expect(error.failure).toBe('timeout');
    expect(error.code).toBe('PROVIDER_TIMEOUT');
  });

  test('caller cancellation is reported as cancelled', async () => {
    const controller = new AbortController();
    const hang = ((_: unknown, init?: RequestInit) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const pending = providerFetch(ctx(hang, { signal: controller.signal, timeoutMs: 5000 }), 'https://x', {}).catch((e) => e);
    controller.abort();
    expect((await pending).failure).toBe('cancelled');
  });

  test('scrub ignores trivially short secrets', () => {
    expect(scrub('abc', 'ab')).toBe('abc');
  });
});
