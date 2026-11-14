import { describe, expect, test } from 'bun:test';
import type { ApiErrorBody, ApiSuccess, ConfigurationDocument, ImportPlan, ImportResult, ModelInfo, ProviderInfo, RoleInfo } from '@clawrouter/shared';
import { createHarness, type Harness } from '../../../tests/support/harness.ts';

const data = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;
const errorOf = async (res: Response) => ((await res.json()) as ApiErrorBody).error;
const actor = { id: 'u1', username: 'admin' };

/** A fully configured instance: provider with key, model, alias, limits, custom role, settings, sign-in policy, mail. */
async function source() {
  const h = createHarness();
  const admin = await h.completeSetup();
  const openai = await h.providers.create(actor, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: 'https://api.openai.example/v1', apiKey: 'sk-export-canary-0123456789', priority: 10, maxKeyLifetimeHours: 720 }, { ip: null });
  const local = await h.providers.create(actor, { name: 'Local', identifier: 'local', kind: 'openai_compatible', endpoint: 'http://10.0.0.5:8000/v1', priority: 50 }, { ip: null });
  h.models.create(actor, { providerId: openai.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT', 'CODING'], cost: { inputPerMTok: 0.15, outputPerMTok: 0.6 }, contextLength: 128000 }, { ip: null });
  h.models.create(actor, { providerId: local.id, providerModelId: 'llama-3', capabilities: ['CHAT'] }, { ip: null });
  const put = (path: string, json: unknown) => h.request(path, { method: 'PUT', cookie: admin, json });
  expect((await put('/api/routing', {
    version: 0, defaultPolicy: { failover: 'RETRY_AND_FAILOVER', maxAttempts: 3, retriesPerTarget: 1 },
    aliases: [{ name: 'chat', description: 'Default chat', enabled: true, capabilities: ['CHAT'], policy: null, targets: [{ modelRef: 'openai/gpt-4o-mini', priority: 0, weight: 1 }, { modelRef: 'local/llama-3', priority: 1, weight: 1 }] }],
  })).status).toBe(200);
  const limits = await data<{ version: number }>(await h.request('/api/rate-limits', { cookie: admin }));
  expect((await put('/api/rate-limits', { version: limits.version, perKey: { requestsPerMinute: 300, tokensPerMinute: null }, perUser: { requestsPerMinute: null, tokensPerMinute: null }, perModel: [], global: { requestsPerMinute: null, tokensPerMinute: null, maxConcurrent: 250 }, invalidKeysPerIp: 20 })).status).toBe(200);
  expect((await h.request('/api/roles', { method: 'POST', cookie: admin, json: { name: 'Developer', description: 'Own keys', permissions: ['models.read', 'api_keys.own'] } })).status).toBe(201);
  expect((await put('/api/settings', { values: { sessionIdleMinutes: 90, keyMaxLifetimeDays: 14 } })).status).toBe(200);

  expect((await put('/api/settings/mail', { enabled: true, host: 'smtp.example.test', port: 587, security: 'starttls', username: 'mailer', password: 'smtp-export-canary', from: 'ClawRouter <c@example.test>' })).status).toBe(200);
  // After the mail server: email codes need one.
  expect((await put('/api/settings/sign-in', { methods: { totp: true, email: true }, require: 'off' })).status).toBe(200);
  return { h, admin };
}

const exportFrom = async (h: Harness, cookie: string) => data<ConfigurationDocument>(await h.request('/api/configuration/export', { cookie }));

describe('configuration export/import (phase 17)', () => {
  test('exports everything but secrets', async () => {
    const { h, admin } = await source();
    const res = await h.request('/api/configuration/export', { cookie: admin });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const doc = await data<ConfigurationDocument>(res);
    expect(doc).toMatchObject({ format: 'clawrouter-configuration', formatVersion: 1, clawrouterVersion: 'test' });
    expect(doc.providers.map((p) => [p.identifier, p.hadApiKey])).toEqual([['openai', true], ['local', false]]);
    expect(doc.models.map((m) => `${m.provider}/${m.providerModelId}`)).toEqual(['openai/gpt-4o-mini', 'local/llama-3']);
    expect(doc.routing.aliases.map((a) => a.name)).toEqual(['chat']);
    expect(doc.rateLimits.perKey.requestsPerMinute).toBe(300);
    expect(doc.roles).toEqual([{ name: 'Developer', description: 'Own keys', permissions: ['api_keys.own', 'models.read'] }]);
    expect(doc.settings.system).toEqual({ sessionIdleMinutes: 90, keyMaxLifetimeDays: 14 });
    expect(doc.settings.mail).toEqual({ enabled: true, host: 'smtp.example.test', port: 587, security: 'starttls', username: 'mailer', from: 'ClawRouter <c@example.test>' });
    const text = JSON.stringify(doc);
    expect(text).not.toContain('sk-export-canary');
    expect(text).not.toContain('smtp-export-canary');
    expect(text).not.toMatch(/ciphertext|password/i);
    expect(h.audit.list({ action: 'CONFIGURATION_EXPORTED' })).toHaveLength(1);
  });

  test('a fresh instance imports it after a preview; importing again changes nothing', async () => {
    const { h, admin } = await source();
    const doc = await exportFrom(h, admin);
    const t = createHarness();
    const tAdmin = await t.completeSetup();
    const post = (path: string, json: unknown) => t.request(path, { method: 'POST', cookie: tAdmin, json });

    const plan = await data<ImportPlan>(await post('/api/configuration/import/preview', doc));
    expect(plan.missingPermissions).toEqual([]);
    expect(plan.counts).toMatchObject({ roles: { create: 1 }, providers: { create: 2 }, models: { create: 2 }, routing: { update: 1 }, rateLimits: { update: 1 }, settings: { update: 3 } });
    expect(plan.changes.find((c) => c.name === 'openai')!.note).toContain('enter its API key');
    expect(plan.changes.find((c) => c.name === 'mail server')!.note).toContain('mail server password');
    expect(t.providers.list()).toEqual([]); // a preview changes nothing

    const result = await data<ImportResult>(await post('/api/configuration/import', doc));
    expect(result.failed).toBeNull();
    expect(result.backup).toBeNull(); // in-memory test database: no backup file
    const providers = await data<ProviderInfo[]>(await t.request('/api/providers', { cookie: tAdmin }));
    expect(providers.map((p) => [p.identifier, p.priority, p.credential.configured, p.maxKeyLifetimeHours])).toEqual([['openai', 10, false, 720], ['local', 50, false, null]]);
    const model = (await data<ModelInfo[]>(await t.request('/api/models?q=gpt-4o-mini', { cookie: tAdmin })))[0]!;
    expect(model).toMatchObject({ ref: 'openai/gpt-4o-mini', contextLength: 128000, cost: { inputPerMTok: 0.15, outputPerMTok: 0.6 } });
    expect(t.routing.get().aliases.map((a) => a.targets.map((x) => x.modelRef))).toEqual([['openai/gpt-4o-mini', 'local/llama-3']]);
    expect(t.limits.get().global.maxConcurrent).toBe(250);
    expect((await data<RoleInfo[]>(await t.request('/api/roles', { cookie: tAdmin }))).find((r) => r.name === 'Developer')!.permissions).toEqual(['api_keys.own', 'models.read']);
    expect(t.settings.get('keyMaxLifetimeDays')).toBe(14);
    expect(t.twoFactor.policy().methods).toEqual({ totp: true, email: true });
    expect(t.mail.get()).toMatchObject({ host: 'smtp.example.test', passwordSet: false });
    expect(t.audit.list({ action: 'CONFIGURATION_IMPORTED' })[0]!.metadata).toMatchObject({ providers: { create: 2, update: 0 } });
    // Every change went through its service: audited as usual.
    expect(t.audit.list({ action: 'PROVIDER_CREATED' })).toHaveLength(2);

    const again = await data<ImportPlan>(await post('/api/configuration/import/preview', doc));
    expect(again.changes.filter((c) => c.action !== 'unchanged').map((c) => `${c.section} ${c.name}`)).toEqual([]);
  });

  test('merges: updates what differs, never deletes, and keeps a stored key away from a new host', async () => {
    const { h, admin } = await source();
    const doc = await exportFrom(h, admin);
    const t = createHarness();
    const tAdmin = await t.completeSetup();
    const extra = await t.providers.create(actor, { name: 'Extra', identifier: 'extra', kind: 'openai_compatible', endpoint: 'http://10.0.0.9/v1' }, { ip: null });
    await t.providers.create(actor, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: 'https://old-host.example/v1', apiKey: 'sk-target-0123456789abcdef', priority: 99 }, { ip: null });
    const plan = await data<ImportPlan>(await t.request('/api/configuration/import/preview', { method: 'POST', cookie: tAdmin, json: doc }));
    const openai = plan.changes.find((c) => c.name === 'openai')!;
    expect(openai).toMatchObject({ action: 'update' });
    expect(openai.fields).toContain('priority');
    expect(openai.fields).not.toContain('endpoint');
    expect(openai.note).toContain('another host');
    await t.request('/api/configuration/import', { method: 'POST', cookie: tAdmin, json: doc });
    const after = t.providers.list();
    expect(after.find((p) => p.identifier === 'openai')).toMatchObject({ priority: 10, endpoint: 'https://old-host.example/v1', credential: { configured: true } });
    expect(after.some((p) => p.id === extra.id)).toBe(true);
  });

  test('importing needs every permission it touches; bad files are refused', async () => {
    const { h, admin } = await source();
    const doc = await exportFrom(h, admin);
    const t = createHarness();
    const tAdmin = await t.completeSetup();
    // Settings administrators who may not touch providers, models, routing, limits or roles.
    const role = await data<RoleInfo>(await t.request('/api/roles', { method: 'POST', cookie: tAdmin, json: { name: 'Settings only', permissions: ['settings.read', 'settings.write'] } }));
    await t.addUser('sally', [role.id]);
    const sally = await t.login('sally');
    const plan = await data<ImportPlan>(await t.request('/api/configuration/import/preview', { method: 'POST', cookie: sally, json: doc }));
    expect(plan.missingPermissions).toEqual(expect.arrayContaining(['providers.write', 'models.write', 'routing.write', 'rate_limits.write', 'roles.write', 'api_keys.own']));
    const refused = await t.request('/api/configuration/import', { method: 'POST', cookie: sally, json: doc });
    expect(refused.status).toBe(403);
    expect(t.providers.list()).toEqual([]);
    const exported = await t.request('/api/configuration/export', { cookie: sally });
    expect(exported.status).toBe(403);
    expect((await errorOf(exported)).message).toContain('providers.read');

    for (const bad of [{}, { format: 'other' }, { ...doc, formatVersion: 2 }, { ...doc, providers: 'x' }, { ...doc, models: [{ provider: 'openai' }] }]) {
      expect((await t.request('/api/configuration/import/preview', { method: 'POST', cookie: tAdmin, json: bad })).status).toBe(400);
    }
  });
});
