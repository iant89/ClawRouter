import { describe, expect, test } from 'bun:test';
import type { ApiErrorBody, ApiSuccess, ModelAlias, ModelInfo, PutRoutingRequest, RoutePlan, RoutingConfigView } from '@clawrouter/shared';
import { createHarness } from '../../../tests/support/harness.ts';

const json = async <T>(res: Response) => (await res.json()) as T;
const actor = { id: 'u', username: 'admin' };
const client = { ip: null };

/** Two providers, three models, an admin, an operator and a viewer. No provider is ever called. */
async function world() {
  const h = createHarness();
  const admin = await h.completeSetup();
  await h.addUser('op', ['OPERATOR']);
  await h.addUser('viewer', ['VIEWER']);
  const a = await h.providers.create(actor, { name: 'Alpha', identifier: 'alpha', kind: 'openai_compatible', endpoint: 'http://localhost:9/v1', priority: 10 }, client);
  const b = await h.providers.create(actor, { name: 'Beta', identifier: 'beta', kind: 'openai_compatible', endpoint: 'http://localhost:8/v1', priority: 20 }, client);
  const m = (providerId: string, id: string, caps: ModelInfo['capabilities'] = ['CHAT']) => h.models.create(actor, { providerId, providerModelId: id, capabilities: caps }, client);
  const models = { ax: m(a.id, 'x'), by: m(b.id, 'y'), bx: m(b.id, 'x', ['CHAT', 'VISION']) };
  return { h, admin, operator: await h.login('op'), viewer: await h.login('viewer'), a, b, models };
}

const fastCode: ModelAlias = {
  name: 'fast-code', description: 'Quick code answers', enabled: true, capabilities: [], policy: null,
  targets: [{ modelRef: 'alpha/x', priority: 0, weight: 1 }, { modelRef: 'beta/y', priority: 1, weight: 1 }],
};

async function put(h: ReturnType<typeof createHarness>, cookie: string, body: PutRoutingRequest) {
  return h.request('/api/routing', { method: 'PUT', cookie, json: body });
}

describe('GET/PUT /api/routing', () => {
  test('starts empty with the default policy, saves aliases, bumps the version, audits and emits', async () => {
    const { h, operator } = await world();
    const events: number[] = [];
    h.events.on('routing.changed', (e) => { events.push(e.version); });
    const initial = (await json<ApiSuccess<RoutingConfigView>>(await h.request('/api/routing', { cookie: operator }))).data;
    expect(initial).toMatchObject({ version: 0, aliases: [], defaultPolicy: { failover: 'RETRY_AND_FAILOVER', maxAttempts: 3, retriesPerTarget: 1 }, problems: [] });

    const res = await put(h, operator, { version: 0, defaultPolicy: initial.defaultPolicy, aliases: [fastCode] });
    expect(res.status).toBe(200);
    const saved = (await json<ApiSuccess<RoutingConfigView>>(res)).data;
    expect(saved).toMatchObject({ version: 1, aliases: [fastCode], problems: [] });
    expect(events).toEqual([1]);
    expect(h.audit.list({ action: 'ROUTING_UPDATED' })[0]!.metadata).toMatchObject({ version: 1, added: ['fast-code'], removed: [], changed: [], defaultPolicyChanged: false });
  });

  test('a stale version is a 409 (no silent overwrite)', async () => {
    const { h, operator } = await world();
    const base = { defaultPolicy: { failover: 'NONE' as const, maxAttempts: 1, retriesPerTarget: 0 }, aliases: [] };
    expect((await put(h, operator, { version: 0, ...base })).status).toBe(200);
    const stale = await put(h, operator, { version: 0, ...base, aliases: [fastCode] });
    expect(stale.status).toBe(409);
    expect((await json<ApiErrorBody>(stale)).error.message).toContain('changed by someone else');
  });

  test('semantic validation: unknown models, duplicates, bad names and ranges', async () => {
    const { h, operator } = await world();
    const bad: ModelAlias[] = [
      { ...fastCode, name: 'has/slash' },
      { ...fastCode, name: 'dup', targets: [{ modelRef: 'alpha/x', priority: 0, weight: 0 }, { modelRef: 'alpha/x', priority: 0, weight: 1 }] },
      { ...fastCode, name: 'DUP' },
      { ...fastCode, name: 'ghost', targets: [{ modelRef: 'nowhere/m', priority: 0, weight: 1 }] },
      { ...fastCode, name: 'empty', targets: [] },
    ];
    const res = await put(h, operator, { version: 0, defaultPolicy: { failover: 'NONE', maxAttempts: 50, retriesPerTarget: 0 }, aliases: bad });
    expect(res.status).toBe(400);
    const paths = (await json<ApiErrorBody>(res)).error.details!.issues!.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining([
      'defaultPolicy.maxAttempts', 'aliases[0].name', 'aliases[1].targets[0].weight', 'aliases[1].targets[1].modelRef',
      'aliases[2].name', 'aliases[3].targets[0].modelRef', 'aliases[4].targets',
    ]));
  });

  test('structural validation rejects wrong shapes and unknown fields', async () => {
    const { h, operator } = await world();
    const res = await h.request('/api/routing', { method: 'PUT', cookie: operator, json: { version: 0, defaultPolicy: { failover: 'SOMETIMES' }, aliases: {}, extra: 1 } });
    expect(res.status).toBe(400);
    expect((await json<ApiErrorBody>(res)).error.details!.issues!.map((i) => i.path)).toEqual(expect.arrayContaining(['extra', 'defaultPolicy.failover', 'aliases']));
  });

  test('a deleted model stays allowed in the stored config but is reported as a problem', async () => {
    const { h, operator, models } = await world();
    await put(h, operator, { version: 0, defaultPolicy: { failover: 'FAILOVER_PROVIDER', maxAttempts: 3, retriesPerTarget: 0 }, aliases: [fastCode] });
    h.models.remove(actor, models.by.id, client);
    const view = (await json<ApiSuccess<RoutingConfigView>>(await h.request('/api/routing', { cookie: operator }))).data;
    expect(view.problems).toEqual([{ alias: 'fast-code', message: 'Target beta/y is no longer registered' }]);
    // Unrelated edits still save.
    const res = await put(h, operator, { version: 1, defaultPolicy: view.defaultPolicy, aliases: [{ ...fastCode, description: 'edited' }] });
    expect(res.status).toBe(200);
  });

  test('an alias with nothing usable is reported', async () => {
    const { h, operator, a } = await world();
    await put(h, operator, { version: 0, defaultPolicy: { failover: 'NONE', maxAttempts: 1, retriesPerTarget: 0 }, aliases: [{ ...fastCode, targets: [{ modelRef: 'alpha/x', priority: 0, weight: 1 }] }] });
    await h.providers.update(actor, a.id, { enabled: false }, client);
    const view = (await json<ApiSuccess<RoutingConfigView>>(await h.request('/api/routing', { cookie: operator }))).data;
    expect(view.problems).toEqual([{ alias: 'fast-code', message: 'No usable model for alias "fast-code".' }]);
  });
});

describe('POST /api/routing/preview (phase 7 exit criterion: deterministic selection)', () => {
  test('alias -> ordered candidates and attempts; repeat requests give the same plan', async () => {
    const { h, operator } = await world();
    await put(h, operator, { version: 0, defaultPolicy: { failover: 'RETRY_AND_FAILOVER', maxAttempts: 3, retriesPerTarget: 1 }, aliases: [fastCode] });
    const preview = async () => (await json<ApiSuccess<RoutePlan>>(await h.request('/api/routing/preview', { method: 'POST', cookie: operator, json: { model: 'fast-code' } }))).data;
    const plan = await preview();
    expect(plan.candidates.map((c) => c.modelRef)).toEqual(['alpha/x', 'beta/y']);
    expect(plan.attempts).toEqual([{ candidate: 0, try: 1 }, { candidate: 0, try: 2 }, { candidate: 1, try: 1 }]);
    expect((await preview()).candidates).toEqual(plan.candidates);
  });

  test('provider model id across providers, with a capability requirement', async () => {
    const { h, viewer } = await world();
    const plan = (await json<ApiSuccess<RoutePlan>>(await h.request('/api/routing/preview', { method: 'POST', cookie: viewer, json: { model: 'x', capabilities: ['VISION'] } }))).data;
    expect(plan.resolvedAs).toBe('model_id');
    expect(plan.candidates.map((c) => c.modelRef)).toEqual(['beta/x']);
    expect(plan.excluded).toEqual([{ modelRef: 'alpha/x', reason: 'Missing capabilities: VISION' }]);
  });

  test('gateway failure history demotes a provider', async () => {
    const { h, operator, a } = await world();
    for (let i = 0; i < 3; i++) h.routing.failures.recordFailure(a.id);
    const plan = h.routing.plan({ model: 'x' });
    expect(plan.candidates.map((c) => c.modelRef)).toEqual(['beta/x', 'alpha/x']);
    h.routing.failures.recordSuccess(a.id);
    expect(h.routing.plan({ model: 'x' }).candidates[0]!.modelRef).toBe('alpha/x');
    expect(operator).toBeTruthy();
  });

  test('nothing routable -> 502 ROUTING_ERROR with the excluded list', async () => {
    const { h, operator, a, b } = await world();
    await h.providers.update(actor, a.id, { enabled: false }, client);
    await h.providers.update(actor, b.id, { enabled: false }, client);
    const res = await h.request('/api/routing/preview', { method: 'POST', cookie: operator, json: { model: 'x' } });
    expect(res.status).toBe(502);
    const body = await json<ApiErrorBody>(res);
    expect(body.error).toMatchObject({ code: 'ROUTING_ERROR', message: 'No usable model for "x".' });
    expect(body.error.details?.excluded).toHaveLength(2);
  });
});

describe('permissions', () => {
  test('viewers can read and preview; only routing.write can save', async () => {
    const { h, viewer } = await world();
    expect((await h.request('/api/routing', { cookie: viewer })).status).toBe(200);
    expect((await put(h, viewer, { version: 0, defaultPolicy: { failover: 'NONE', maxAttempts: 1, retriesPerTarget: 0 }, aliases: [] })).status).toBe(403);
  });
});
