import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { ApiSuccess, Capability, CreatedApiKey, ProviderKind } from '@clawrouter/shared';
import { createHarness } from '../../../tests/support/harness.ts';
import { startMockProviders, type MockProviders } from '../../../tests/support/mock-providers.ts';

let mock: MockProviders;
beforeAll(() => {
  mock = startMockProviders();
});
afterAll(() => mock.stop());
beforeEach(() => {
  mock.mode = 'ok';
  mock.requests.length = 0;
});

const actor = { id: 'u', username: 'admin' };
const client = { ip: null };
type OpenAiError = { error: { message: string; type: string; param: string | null } };
const json = async <T>(res: Response) => (await res.json()) as T;

// A 1×1 PNG, a few bytes of "audio" and "PDF": only the shape matters to the gateway.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const WAV = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const PDF = 'JVBERi0xLjQKJcOkw7zDtsOfCjEgMCBvYmoKPDwvVHlwZS9DYXRhbG9nPj4KZW5kb2JqCnRyYWlsZXIKPDwvUm9vdCAxIDAgUj4+CiUlRU9G';

const image = (url: string, detail?: string) => ({ type: 'image_url', image_url: { url, ...(detail ? { detail } : {}) } });
const ask = (model: string, ...parts: unknown[]) => ({ model, max_tokens: 50, messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: [{ type: 'text', text: 'What is this?' }, ...parts] }] });

/** One provider of each kind, one model each (marked Vision unless said otherwise). */
async function world(vision = true) {
  const h = createHarness();
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  const caps: Capability[] = vision ? ['CHAT', 'VISION'] : ['CHAT'];
  const add = async (identifier: string, kind: ProviderKind, path: string, model: string, priority: number) => {
    const p = await h.providers.create(actor, { name: identifier, identifier, kind, endpoint: `${mock.url}${path}`, apiKey: mock.key, priority }, client);
    h.models.create(actor, { providerId: p.id, providerModelId: model, capabilities: caps }, client);
  };
  await add('openai', 'openai', '/openai/v1', 'gpt-4o-mini', 10);
  await add('anthropic', 'anthropic', '/anthropic', 'claude-sonnet-4-5', 20);
  await add('google', 'google', '/google/v1beta', 'gemini-2.0-flash', 30);
  await add('groq', 'groq', '/groq/openai/v1', 'llama-3.3-70b-versatile', 40);
  const res = await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'ci' } });
  const key = ((await res.json()) as ApiSuccess<CreatedApiKey>).data.secret;
  const v1 = (body: unknown) => h.request('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, json: body });
  return { h, v1 };
}

const sent = () => mock.requests.filter((r) => r.method === 'POST').at(-1)!.body as Record<string, unknown>;

describe('media in chat messages', () => {
  test('OpenAI gets images, audio and PDFs in its own part format', async () => {
    const { v1 } = await world();
    const res = await v1(ask('openai/gpt-4o-mini',
      image('https://example.com/cat.png', 'low'),
      image(`data:image/png;base64,${PNG}`),
      { type: 'input_audio', input_audio: { data: WAV, format: 'wav' } },
      { type: 'file', file: { filename: 'report.pdf', file_data: `data:application/pdf;base64,${PDF}` } }));
    expect(res.status).toBe(200);
    const msgs = sent().messages as { role: string; content: unknown }[];
    expect(msgs[0]).toEqual({ role: 'system', content: 'Be brief.' });
    expect(msgs[1]!.content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: 'https://example.com/cat.png', detail: 'low' } },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
      { type: 'input_audio', input_audio: { data: WAV, format: 'wav' } },
      { type: 'file', file: { filename: 'report.pdf', file_data: `data:application/pdf;base64,${PDF}` } },
    ]);
  });

  test('Anthropic gets image blocks (URL or base64) and PDFs as documents', async () => {
    const { v1 } = await world();
    const res = await v1(ask('anthropic/claude-sonnet-4-5',
      image('https://example.com/cat.png'),
      image(`data:image/png;base64,${PNG}`),
      { type: 'file', file: { filename: 'report.pdf', file_data: `data:application/pdf;base64,${PDF}` } }));
    expect(res.status).toBe(200);
    const body = sent();
    expect(body.system).toBe('Be brief.');
    expect((body.messages as { content: unknown }[])[0]!.content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF }, title: 'report.pdf' },
    ]);
  });

  test('Gemini gets everything as inline data', async () => {
    const { v1 } = await world();
    const res = await v1(ask('google/gemini-2.0-flash',
      image(`data:image/png;base64,${PNG}`),
      { type: 'input_audio', input_audio: { data: WAV, format: 'mp3' } },
      { type: 'file', file: { file_data: `data:application/pdf;base64,${PDF}` } }));
    expect(res.status).toBe(200);
    expect((sent().contents as { parts: unknown }[])[0]!.parts).toEqual([
      { text: 'What is this?' },
      { inlineData: { mimeType: 'image/png', data: PNG } },
      { inlineData: { mimeType: 'audio/mp3', data: WAV } },
      { inlineData: { mimeType: 'application/pdf', data: PDF } },
    ]);
  });

  test('plain text messages are sent exactly as before', async () => {
    const { v1 } = await world();
    await v1({ model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi ' }, { type: 'text', text: 'there' }] }] });
    expect(sent().messages).toEqual([{ role: 'user', content: 'Hi there' }]);
  });

  test('routing skips providers that cannot take the media, and models not marked Vision', async () => {
    const { v1 } = await world();
    // An image URL by model id offered nowhere else: Google cannot fetch URLs, so only OpenAI-style and Anthropic qualify.
    const pdf = await v1(ask('openai/gpt-4o-mini', { type: 'file', file: { file_data: `data:application/pdf;base64,${PDF}` } }));
    expect(pdf.status).toBe(200);
    const groqPdf = await v1(ask('groq/llama-3.3-70b-versatile', { type: 'file', file: { file_data: `data:application/pdf;base64,${PDF}` } }));
    expect(groqPdf.status).toBe(400);
    expect((await json<OpenAiError>(groqPdf)).error).toMatchObject({ type: 'invalid_request_error', param: 'messages', message: expect.stringContaining('accepts PDF files') });
    const googleUrl = await v1(ask('google/gemini-2.0-flash', image('https://example.com/cat.png')));
    expect(googleUrl.status).toBe(400);
    expect((await json<OpenAiError>(googleUrl)).error.message).toContain('Google takes images inline only');

    const { v1: noVision } = await world(false);
    const res = await noVision(ask('openai/gpt-4o-mini', image(`data:image/png;base64,${PNG}`)));
    expect(res.status).toBe(400);
    expect((await json<OpenAiError>(res)).error.message).toContain('Images need a model marked Vision');
  });

  test('bad media is refused with the parameter named', async () => {
    const { v1 } = await world();
    const cases: [unknown, string][] = [
      [ask('openai/gpt-4o-mini', image('ftp://example.com/cat.png')), 'messages[1].content[1].image_url.url'],
      [ask('openai/gpt-4o-mini', image('data:image/tiff;base64,AAAA')), 'messages[1].content[1].image_url.url'],
      [ask('openai/gpt-4o-mini', image('data:image/png;base64,not base64!')), 'messages[1].content[1].image_url.url'],
      [ask('openai/gpt-4o-mini', image('https://example.com/a.png', 'ultra')), 'messages[1].content[1].image_url.detail'],
      [ask('openai/gpt-4o-mini', { type: 'input_audio', input_audio: { data: WAV, format: 'ogg' } }), 'messages[1].content[1].input_audio'],
      [ask('openai/gpt-4o-mini', { type: 'file', file: { file_id: 'file-abc' } }), 'messages[1].content[1].file.file_id'],
      [ask('openai/gpt-4o-mini', { type: 'file', file: { file_data: `data:text/plain;base64,${PNG}` } }), 'messages[1].content[1].file.file_data'],
      [{ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: [image(`data:image/png;base64,${PNG}`)] }] }, 'messages[1].content[0]'],
      [ask('openai/gpt-4o-mini', ...Array.from({ length: 51 }, () => image('https://example.com/a.png'))), 'messages'],
    ];
    for (const [body, param] of cases) {
      const res = await v1(body);
      expect([param, res.status]).toEqual([param, 400]);
      expect((await json<OpenAiError>(res)).error.param).toBe(param);
    }
  });

  test('media never reaches the request history, logs or events', async () => {
    const { h, v1 } = await world();
    const seen: string[] = [];
    for (const name of ['request.started', 'request.completed'] as const) h.events.on(name, (p) => void seen.push(JSON.stringify(p)));
    const res = await v1(ask('openai/gpt-4o-mini', image(`data:image/png;base64,${PNG}`)));
    expect(res.status).toBe(200);
    await Bun.sleep(5);
    const stored = JSON.stringify(h.db.all('SELECT * FROM requests')) + JSON.stringify(h.logs) + seen.join('');
    expect(stored).not.toContain(PNG.slice(0, 40));
  });
});
