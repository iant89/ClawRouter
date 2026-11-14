import { describe, expect, test } from 'bun:test';
import type { ApiKeyInfo, ApiSuccess, CreatedApiKey } from '@clawrouter/shared';
import { createHarness } from '../../../tests/support/harness.ts';

type Page = ApiSuccess<ApiKeyInfo[]> & { meta: { page: number; pageSize: number; total: number; active: number } };

describe('GET /api/api-keys pages and filters on the server (phase 16)', () => {
  test('pages, searches by name, prefix or owner, and filters by status', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const make = async (name: string, json: Record<string, unknown> = {}) =>
      ((await (await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name, ...json } })).json()) as ApiSuccess<CreatedApiKey>).data.key;
    for (let i = 0; i < 12; i++) {
      await make(`batch-${i}`);
      h.clock.advance(1000);
    }
    const shortLived = await make('short-lived', { expiry: { type: 'after', hours: 1 } });
    const revoked = await make('old-job');
    await h.request(`/api/api-keys/${revoked.id}`, { method: 'DELETE', cookie: admin });
    h.clock.advance(2 * 3_600_000);
    const admin2 = await h.login();
    const list = async (query: string) => {
      const res = await h.request(`/api/api-keys${query}`, { cookie: admin2 });
      return { status: res.status, body: res.status === 200 ? ((await res.json()) as Page) : null };
    };

    const first = (await list('?pageSize=5')).body!;
    expect(first.data).toHaveLength(5);
    expect(first.meta).toMatchObject({ page: 1, pageSize: 5, total: 14, active: 12 });
    expect((await list('?pageSize=5&page=3')).body!.data.map((k) => k.name)).toEqual(['batch-2', 'batch-1', 'batch-0', 'old-job']); // newest first, revoked last
    expect((await list('?q=BATCH-1')).body!.data.map((k) => k.name).sort()).toEqual(['batch-1', 'batch-10', 'batch-11']);
    expect((await list(`?q=${shortLived.prefix}`)).body!.data.map((k) => k.name)).toEqual(['short-lived']);
    expect((await list('?q=admin')).body!.meta.total).toBe(14); // the owner's username
    expect((await list('?q=%25')).body!.meta.total).toBe(0); // wildcards are literal
    expect((await list('?status=EXPIRED')).body!.data.map((k) => k.name)).toEqual(['short-lived']);
    expect((await list('?status=REVOKED')).body!.data.map((k) => k.name)).toEqual(['old-job']);
    expect((await list('?status=ACTIVE')).body!.meta.total).toBe(12);
    for (const bad of ['?status=LOST', '?pageSize=500', '?page=0']) expect((await list(bad)).status).toBe(400);
  });
});
