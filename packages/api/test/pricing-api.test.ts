import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { ApiSuccess, ModelInfo, ProviderInfo } from '@clawrouter/shared';
import { createHarness } from '../../../tests/support/harness.ts';
import { startMockProviders, type MockProviders } from '../../../tests/support/mock-providers.ts';

let mock: MockProviders;
beforeAll(() => {
  mock = startMockProviders();
});
afterAll(() => mock.stop());
beforeEach(() => {
  mock.groqPrices = {};
});

const data = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;

/** A Groq provider with two imported models (prices published by the fake Groq). */
async function world() {
  const h = createHarness();
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  const provider = await data<ProviderInfo>(await h.request('/api/providers', { method: 'POST', cookie: admin, json: { name: 'Groq', identifier: 'groq', kind: 'groq', endpoint: `${mock.url}/groq/openai/v1`, apiKey: mock.key } }));
  await h.request(`/api/providers/${provider.id}/models/import`, { method: 'POST', cookie: admin, json: { providerModelIds: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'] } });
  const model = (id: string) => h.models.listAll().find((m) => m.providerModelId === id)!;
  /** A connection test (as the periodic health check does) refreshes the model list. */
  const refresh = async () => {
    expect((await h.request(`/api/providers/${provider.id}/test`, { method: 'POST', cookie: admin })).status).toBe(200);
    await Bun.sleep(5);
  };
  return { h, admin, provider, model, refresh };
}

describe('automatic pricing', () => {
  test('imported models take the published price and follow it when the provider changes it', async () => {
    const { h, model, refresh } = await world();
    expect(model('llama-3.3-70b-versatile')).toMatchObject({ cost: { inputPerMTok: 0.59, outputPerMTok: 0.79 }, costSource: 'PROVIDER' });

    mock.groqPrices = { 'llama-3.3-70b-versatile': { prompt: '0.0000005', completion: '0.0000007' } };
    await refresh();
    expect(model('llama-3.3-70b-versatile')).toMatchObject({ cost: { inputPerMTok: 0.5, outputPerMTok: 0.7 }, costSource: 'PROVIDER' });
    expect(model('openai/gpt-oss-120b').cost).toMatchObject({ inputPerMTok: 0.15 }); // unchanged

    const record = h.audit.search({ action: 'MODEL_UPDATED' }).items.find((r) => r.resourceId === model('llama-3.3-70b-versatile').id)!;
    expect(record).toMatchObject({ actorName: 'automatic pricing', actorId: null });
    expect(record.metadata).toMatchObject({ automatic: true, changes: { cost: { from: { inputPerMTok: 0.59 }, to: { inputPerMTok: 0.5 } } } });

    // A refresh without changes records nothing new.
    const before = h.audit.search({ action: 'MODEL_UPDATED' }).total;
    await refresh();
    expect(h.audit.search({ action: 'MODEL_UPDATED' }).total).toBe(before);
  });

  test('a price set by hand is never overwritten, until the administrator switches back', async () => {
    const { h, admin, model, refresh } = await world();
    const id = model('llama-3.3-70b-versatile').id;
    const manual = await data<ModelInfo>(await h.request(`/api/models/${id}`, { method: 'PATCH', cookie: admin, json: { cost: { inputPerMTok: 1, outputPerMTok: 2 } } }));
    expect(manual).toMatchObject({ cost: { inputPerMTok: 1, outputPerMTok: 2 }, costSource: 'MANUAL' });

    mock.groqPrices = { 'llama-3.3-70b-versatile': { prompt: '0.0000005', completion: '0.0000007' } };
    await refresh();
    expect(model('llama-3.3-70b-versatile')).toMatchObject({ cost: { inputPerMTok: 1, outputPerMTok: 2 }, costSource: 'MANUAL' });

    const back = await h.request(`/api/models/${id}`, { method: 'PATCH', cookie: admin, json: { costSource: 'PROVIDER' } });
    expect((await data<ModelInfo>(back)).costSource).toBe('PROVIDER');
    await refresh();
    expect(model('llama-3.3-70b-versatile')).toMatchObject({ cost: { inputPerMTok: 0.5, outputPerMTok: 0.7 }, costSource: 'PROVIDER' });

    const both = await h.request(`/api/models/${id}`, { method: 'PATCH', cookie: admin, json: { costSource: 'PROVIDER', cost: { inputPerMTok: 1, outputPerMTok: 1 } } });
    expect(both.status).toBe(400);
    // Saving other fields with the same price keeps it automatic; MANUAL pins the current price.
    const renamed = await data<ModelInfo>(await h.request(`/api/models/${id}`, { method: 'PATCH', cookie: admin, json: { displayName: 'Llama', cost: { inputPerMTok: 0.5, outputPerMTok: 0.7 } } }));
    expect(renamed).toMatchObject({ displayName: 'Llama', costSource: 'PROVIDER' });
    const pinned = await data<ModelInfo>(await h.request(`/api/models/${id}`, { method: 'PATCH', cookie: admin, json: { costSource: 'MANUAL' } }));
    expect(pinned).toMatchObject({ cost: { inputPerMTok: 0.5, outputPerMTok: 0.7 }, costSource: 'MANUAL' });
    expect((await h.request(`/api/models/${id}`, { method: 'PATCH', cookie: admin, json: { costSource: 'AUTO' } })).status).toBe(400);
  });

  test('models without a price get one when the provider starts publishing it; a withdrawn price is kept', async () => {
    const { h, admin, provider, model, refresh } = await world();
    // Registered by hand, without a price.
    await h.request('/api/models', { method: 'POST', cookie: admin, json: { providerId: provider.id, providerModelId: 'qwen/qwen3.8-27b' } });
    mock.groqPrices = { 'qwen/qwen3.8-27b': null };
    await refresh();
    expect(model('qwen/qwen3.8-27b')).toMatchObject({ cost: null, costSource: null });

    mock.groqPrices = {};
    await refresh();
    expect(model('qwen/qwen3.8-27b')).toMatchObject({ cost: { inputPerMTok: 0.8, outputPerMTok: 4 }, costSource: 'PROVIDER' });

    mock.groqPrices = { 'qwen/qwen3.8-27b': null };
    await refresh();
    expect(model('qwen/qwen3.8-27b').cost).toMatchObject({ inputPerMTok: 0.8 });
  });

  test('prices typed in before this change count as set by hand', async () => {
    const { h, model, refresh } = await world();
    const id = model('openai/gpt-oss-120b').id;
    h.db.run("UPDATE models SET cost_input_per_mtok = 9, cost_output_per_mtok = 9, cost_source = NULL WHERE id = ?", [id]);
    h.db.run("UPDATE models SET cost_source = 'MANUAL' WHERE (cost_input_per_mtok IS NOT NULL OR cost_output_per_mtok IS NOT NULL) AND cost_source IS NULL AND id = ?", [id]); // what migration 0019 does
    await refresh();
    expect(model('openai/gpt-oss-120b')).toMatchObject({ cost: { inputPerMTok: 9, outputPerMTok: 9 }, costSource: 'MANUAL' });
  });
});
