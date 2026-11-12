import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHarness, type Harness } from '../../../tests/support/harness.ts';
import { startMockProviders, type MockProviders } from '../../../tests/support/mock-providers.ts';

let mock: MockProviders;
beforeAll(() => {
  mock = startMockProviders();
});
afterAll(() => mock.stop());
beforeEach(() => {
  mock.mode = 'ok';
  mock.openaiModels = ['gpt-4o-mini', 'gpt-4o', 'text-embedding-3-small'];
});

const actor = { id: 'u', username: 'admin' };
const client = { ip: null };

async function withProviders(h: Harness = createHarness()) {
  h.setProviderFetch(fetch);
  const openai = await h.providers.create(actor, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: `${mock.url}/openai/v1`, apiKey: mock.key }, client);
  const google = await h.providers.create(actor, { name: 'Google', identifier: 'google', kind: 'google', endpoint: `${mock.url}/google/v1beta`, apiKey: mock.key }, client);
  return { h, openai, google };
}

describe('discovery and import', () => {
  test('discover lists offered models with pre-selected capabilities and limits', async () => {
    const { h, google } = await withProviders();
    const found = await h.models.discover(google.id);
    expect(found).toEqual([
      { providerModelId: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', contextLength: 1048576, maxOutputTokens: 8192, capabilities: ['CHAT'], registered: false },
      { providerModelId: 'text-embedding-004', displayName: 'Text Embedding 004', contextLength: 2048, maxOutputTokens: 1, capabilities: ['EMBEDDINGS'], registered: false },
    ]);
  });

  test('import creates AVAILABLE models, skips already registered ones, and audits each', async () => {
    const { h, openai } = await withProviders();
    const first = await h.models.import(actor, openai.id, ['gpt-4o-mini', 'text-embedding-3-small'], client);
    expect(first.imported).toBe(2);
    expect(first.models.map((m) => [m.ref, m.availability, m.source, m.capabilities])).toEqual([
      ['openai/gpt-4o-mini', 'AVAILABLE', 'DISCOVERED', ['CHAT']],
      ['openai/text-embedding-3-small', 'AVAILABLE', 'DISCOVERED', ['EMBEDDINGS']],
    ]);
    const again = await h.models.import(actor, openai.id, ['gpt-4o-mini', 'gpt-4o'], client);
    expect([again.imported, again.skipped]).toEqual([1, 1]);
    expect(h.audit.list({ action: 'MODEL_CREATED' })).toHaveLength(3);
    expect((await h.models.discover(openai.id)).filter((m) => m.registered).length).toBe(3);
  });

  test('only models the provider actually offers can be imported', async () => {
    const { h, openai } = await withProviders();
    const error = await h.models.import(actor, openai.id, ['gpt-4o-mini', 'made-up-model'], client).catch((e) => e);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details.issues[0].message).toContain('made-up-model');
    expect(h.models.list().total).toBe(0);
  });

  test('discovery failures are reported, not swallowed', async () => {
    const { h, openai } = await withProviders();
    mock.mode = 'auth';
    const error = await h.models.discover(openai.id).catch((e) => e);
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.message).toContain('rejected the credentials');
  });
});

describe('manual models', () => {
  test('create, update (audited per change), delete', async () => {
    const { h, openai } = await withProviders();
    const m = h.models.create(actor, { providerId: openai.id, providerModelId: 'ft:gpt-4o-mini:acme', displayName: 'Acme fine-tune', capabilities: ['CHAT', 'CODING', 'CHAT'], contextLength: 128000, cost: { inputPerMTok: 0.3, outputPerMTok: 1.2 } }, client);
    expect(m).toMatchObject({ ref: 'openai/ft:gpt-4o-mini:acme', source: 'MANUAL', availability: 'UNKNOWN', capabilities: ['CHAT', 'CODING'], cost: { inputPerMTok: 0.3, outputPerMTok: 1.2, currency: 'USD' }, usable: true });
    expect(() => h.models.create(actor, { providerId: openai.id, providerModelId: 'ft:gpt-4o-mini:acme' }, client)).toThrow(expect.objectContaining({ code: 'CONFLICT' }));

    const updated = h.models.update(actor, m.id, { contextLength: null, cost: null, enabled: false }, client);
    expect(updated).toMatchObject({ contextLength: null, cost: null, enabled: false, usable: false, unusableReason: 'Model is disabled' });
    expect(h.audit.list().map((r) => r.action)).toEqual(expect.arrayContaining(['MODEL_UPDATED', 'MODEL_DISABLED']));
    const before = h.audit.list().length;
    h.models.update(actor, m.id, { enabled: false }, client); // no-op
    expect(h.audit.list().length).toBe(before);

    h.models.remove(actor, m.id, client);
    expect(() => h.models.get(m.id)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  test('validation', async () => {
    const { h, openai } = await withProviders();
    const error = (() => {
      try {
        h.models.create(actor, { providerId: openai.id, providerModelId: 'has space', contextLength: 0, capabilities: ['TELEPATHY' as never], cost: { inputPerMTok: -1, outputPerMTok: null } }, client);
      } catch (e) {
        return e as { details: { issues: { path: string }[] } };
      }
    })();
    expect(error!.details.issues.map((i) => i.path).sort()).toEqual(['capabilities', 'contextLength', 'cost.inputPerMTok', 'providerModelId']);
    expect(() => h.models.create(actor, { providerId: 'nope', providerModelId: 'x' }, client)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  test('deleting a provider deletes its models', async () => {
    const { h, openai } = await withProviders();
    await h.models.import(actor, openai.id, ['gpt-4o'], client);
    h.providers.remove(actor, openai.id, client);
    expect(h.models.list().total).toBe(0);
  });
});

describe('availability (spec §9: separate from provider availability)', () => {
  test('health checks mark models AVAILABLE / UNAVAILABLE and notify on changes', async () => {
    const { h, openai } = await withProviders();
    const viewer = (await h.addUser('v', ['VIEWER'])).id;
    const manual = h.models.create(actor, { providerId: openai.id, providerModelId: 'gpt-4o' }, client);
    await h.models.import(actor, openai.id, ['gpt-4o-mini'], client);
    await h.providers.checkAll();
    expect(h.models.get(manual.id).availability).toBe('AVAILABLE');

    mock.openaiModels = ['gpt-4o-mini']; // gpt-4o disappears
    await h.providers.checkAll();
    const gone = h.models.get(manual.id);
    expect(gone).toMatchObject({ availability: 'UNAVAILABLE', usable: false, unusableReason: 'No longer offered by the provider' });
    const notes = h.notifications.list({ userId: viewer, permissions: [...h.authz.principalFor(viewer).permissions] }).items;
    expect(notes.map((n) => n.title)).toContain('Model gpt-4o is no longer offered');

    mock.openaiModels = ['gpt-4o-mini', 'gpt-4o'];
    await h.providers.checkAll();
    expect(h.models.get(manual.id).availability).toBe('AVAILABLE');
  });

  test('a listing fills missing limits but never overwrites administrator values', async () => {
    const { h, google } = await withProviders();
    const a = h.models.create(actor, { providerId: google.id, providerModelId: 'gemini-2.0-flash' }, client);
    const b = h.models.create(actor, { providerId: google.id, providerModelId: 'text-embedding-004', contextLength: 999 }, client);
    await h.providers.checkAll();
    expect(h.models.get(a.id).contextLength).toBe(1048576);
    expect(h.models.get(b.id).contextLength).toBe(999);
  });

  test('a healthy model is unusable while its provider is offline or disabled', async () => {
    const { h, openai } = await withProviders();
    const [m] = (await h.models.import(actor, openai.id, ['gpt-4o'], client)).models;
    mock.mode = 'server_error';
    await h.providers.checkAll();
    expect(h.models.get(m!.id)).toMatchObject({ availability: 'AVAILABLE', usable: false, unusableReason: 'Provider is offline' });
    mock.mode = 'ok';
    await h.providers.update(actor, openai.id, { enabled: false }, client);
    expect(h.models.get(m!.id).unusableReason).toBe('Provider is disabled');
  });
});

describe('queries (server-side pagination and filters)', () => {
  test('filter by provider, capability, text and usability; paginate', async () => {
    const { h, openai, google } = await withProviders();
    await h.models.import(actor, openai.id, ['gpt-4o-mini', 'gpt-4o', 'text-embedding-3-small'], client);
    await h.models.import(actor, google.id, ['gemini-2.0-flash', 'text-embedding-004'], client);
    expect(h.models.list().total).toBe(5);
    expect(h.models.list({ providerId: google.id }).total).toBe(2);
    // Ordered by provider priority, then provider name, then model name.
    expect(h.models.list({ capability: 'EMBEDDINGS' }).items.map((m) => m.ref)).toEqual(['google/text-embedding-004', 'openai/text-embedding-3-small']);
    expect(h.models.list({ q: 'GEMINI' }).items.map((m) => m.ref)).toEqual(['google/gemini-2.0-flash']);
    expect(h.models.list({ q: '100%_' }).total).toBe(0); // LIKE wildcards are escaped
    const page2 = h.models.list({ page: 2, pageSize: 2 });
    expect([page2.items.length, page2.total]).toEqual([2, 5]);
    await h.providers.update(actor, google.id, { enabled: false }, client);
    expect(h.models.list({ usableOnly: true }).total).toBe(3);
  });

  test('providers expose usable models to the rest of ClawAPI (phase 6 exit criterion)', async () => {
    const { h, openai, google } = await withProviders();
    await h.models.import(actor, openai.id, ['gpt-4o-mini', 'text-embedding-3-small'], client);
    await h.models.import(actor, google.id, ['gemini-2.0-flash'], client);
    expect(h.models.listUsable('CHAT').map((m) => m.ref)).toEqual(['google/gemini-2.0-flash', 'openai/gpt-4o-mini']);
    const resolved = h.models.resolveRef('google/gemini-2.0-flash')!;
    expect(resolved.usable).toBe(true);
    const reply = await h.providers.chat(resolved.providerId, { model: resolved.providerModelId, messages: [{ role: 'user', content: 'hi' }] });
    expect(reply.content).toBe('Hello from Gemini');
    expect(h.models.resolveRef('nope')).toBeUndefined();
    expect(h.models.resolveRef('openai/unknown')).toBeUndefined();
  });
});
