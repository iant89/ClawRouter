import { describe, expect, test } from 'bun:test';
import type { ApiSuccess, AuthSession, SetupWizardState } from '@clawrouter/shared';
import { migrations, openSqlite, runMigrations } from '@clawrouter/database';
import { createHarness } from '../../../tests/support/harness.ts';

const data = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;
const session = async (h: ReturnType<typeof createHarness>, cookie: string) => data<AuthSession>(await h.request('/api/auth/session', { cookie }));

describe('first-run onboarding (owner request)', () => {
  test('a fresh installation: the first administrator gets the setup wizard and the tour', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    expect((await session(h, admin)).onboarding).toEqual({ tour: 'PENDING', setupWizard: { status: 'PENDING', step: null } });
  });

  test('the wizard records where it is, and its end is audited once', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const put = (json: unknown) => h.request('/api/onboarding/setup-wizard', { method: 'PUT', cookie: admin, json });
    expect(await data<SetupWizardState>(await put({ status: 'PENDING', step: 'models' }))).toEqual({ status: 'PENDING', step: 'models' });
    // An absent step keeps the saved one.
    expect(await data<SetupWizardState>(await put({ status: 'PENDING' }))).toEqual({ status: 'PENDING', step: 'models' });
    expect((await session(h, admin)).onboarding.setupWizard).toEqual({ status: 'PENDING', step: 'models' });
    expect(await data<SetupWizardState>(await put({ status: 'COMPLETED', step: 'mail' }))).toEqual({ status: 'COMPLETED', step: null });
    await put({ status: 'COMPLETED' });
    const records = h.audit.search({ page: 1, pageSize: 10, action: 'SETUP_WIZARD_COMPLETED' }).items;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ resource: 'system', resourceId: 'setup_wizard', metadata: { lastStep: 'models' } });
    expect((await session(h, admin)).onboarding.setupWizard).toEqual({ status: 'COMPLETED', step: null });
  });

  test('dismissing is audited too, and the wizard can be started again', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    await h.request('/api/onboarding/setup-wizard', { method: 'PUT', cookie: admin, json: { status: 'DISMISSED' } });
    expect(h.audit.search({ page: 1, pageSize: 10, action: 'SETUP_WIZARD_DISMISSED' }).total).toBe(1);
    const again = await data<SetupWizardState>(await h.request('/api/onboarding/setup-wizard', { method: 'PUT', cookie: admin, json: { status: 'PENDING', step: null } }));
    expect(again).toEqual({ status: 'PENDING', step: null });
  });

  test('bad wizard input is refused', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    for (const json of [{ status: 'DONE' }, { status: 'PENDING', step: 'nowhere' }, {}]) {
      expect((await h.request('/api/onboarding/setup-wizard', { method: 'PUT', cookie: admin, json })).status).toBe(400);
    }
  });

  test('only users who can change settings see or move the wizard; everyone gets their own tour', async () => {
    const h = createHarness();
    await h.completeSetup();
    await h.addUser('vera', ['VIEWER'], 'quiet meadow lantern 42');
    const viewer = await h.login('vera', 'quiet meadow lantern 42');
    expect((await session(h, viewer)).onboarding).toEqual({ tour: 'PENDING', setupWizard: null });
    expect((await h.request('/api/onboarding/setup-wizard', { method: 'PUT', cookie: viewer, json: { status: 'COMPLETED' } })).status).toBe(403);
  });

  test('finishing or skipping the tour is remembered per user', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    await h.addUser('vera', ['VIEWER'], 'quiet meadow lantern 42');
    const viewer = await h.login('vera', 'quiet meadow lantern 42');
    expect(await data<{ tour: string }>(await h.request('/api/auth/tour', { method: 'POST', cookie: viewer, json: { outcome: 'SKIPPED' } }))).toEqual({ tour: 'SKIPPED' });
    expect((await session(h, viewer)).onboarding.tour).toBe('SKIPPED');
    expect((await session(h, admin)).onboarding.tour).toBe('PENDING');
    await h.request('/api/auth/tour', { method: 'POST', cookie: admin, json: { outcome: 'COMPLETED' } });
    expect((await session(h, admin)).onboarding.tour).toBe('COMPLETED');
    expect((await h.request('/api/auth/tour', { method: 'POST', cookie: admin, json: { outcome: 'LATER' } })).status).toBe(400);
    expect((await h.request('/api/auth/tour', { method: 'POST', json: { outcome: 'COMPLETED' } })).status).toBe(401);
  });

  test('an upgrade marks existing users and the installation as onboarded; later users still get the tour', () => {
    const db = openSqlite({ path: ':memory:' });
    runMigrations(db, migrations.filter((m) => m.id < '0020'));
    const at = '2026-11-01T00:00:00.000Z';
    db.run(`INSERT INTO users (id, username, display_name, password_hash, status, created_at, updated_at, password_changed_at) VALUES ('u1', 'old', 'Old', 'x', 'ACTIVE', ?, ?, ?)`, [at, at, at]);
    runMigrations(db, migrations);
    expect(db.get<{ tour_state: string }>(`SELECT tour_state FROM users WHERE id = 'u1'`)?.tour_state).toBe('COMPLETED');
    expect(JSON.parse(db.get<{ value: string }>(`SELECT value FROM settings WHERE key = 'onboarding.setup_wizard'`)!.value)).toEqual({ status: 'COMPLETED', step: null });
    db.run(`INSERT INTO users (id, username, display_name, password_hash, status, created_at, updated_at, password_changed_at) VALUES ('u2', 'new', 'New', 'x', 'ACTIVE', ?, ?, ?)`, [at, at, at]);
    expect(db.get<{ tour_state: string }>(`SELECT tour_state FROM users WHERE id = 'u2'`)?.tour_state).toBe('PENDING');
  });

  test('a fresh database before setup has no wizard record (so it starts pending)', () => {
    const db = openSqlite({ path: ':memory:' });
    runMigrations(db, migrations);
    expect(db.get(`SELECT value FROM settings WHERE key = 'onboarding.setup_wizard'`)).toBeFalsy();
  });
});
