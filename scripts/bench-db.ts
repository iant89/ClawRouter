/**
 * Database benchmark (phase 16, spec §35): seeds a large SQLite database and times
 * the queries behind the console's lists, searches and charts through the real
 * repositories, with each SQL statement's time and query plan.
 *
 *   bun run bench:db                         default sizes (see SIZES)
 *   bun run bench:db --requests 1000000      more request history
 *   bun run bench:db --keep                  keep the database file afterwards
 *
 * Writes to a temporary directory; never touches the configured database.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteAuditRepository } from '@clawrouter/audit';
import { migrations, openSqlite, runMigrations, type Database, type SqlParams } from '@clawrouter/database';
import { createApiKeyService } from '@clawrouter/gateway';
import { createSqliteModelRepository } from '@clawrouter/models';
import { createSqliteRequestRepository } from '@clawrouter/requests';
import type { AuditService } from '@clawrouter/audit';

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const SIZES = {
  providers: arg('providers', 300),
  models: arg('models', 5000),
  users: arg('users', 200),
  keys: arg('keys', 1000),
  requests: arg('requests', 500_000),
  usageDays: arg('usage-days', 400),
  audit: arg('audit', 300_000),
};
const RUNS = arg('runs', 5);
const NOW = Date.parse('2026-11-14T12:00:00Z');
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();

// ---------------------------------------------------------------- profiling wrapper

interface Stat { sql: string; params: SqlParams | undefined; ms: number; calls: number }
function profile(db: Database) {
  let stats = new Map<string, Stat>();
  const time = <T>(sql: string, params: SqlParams | undefined, fn: () => T): T => {
    const t = performance.now();
    try {
      return fn();
    } finally {
      const ms = performance.now() - t;
      const s = stats.get(sql) ?? { sql, params, ms: 0, calls: 0 };
      s.ms += ms;
      s.calls += 1;
      stats.set(sql, s);
    }
  };
  const wrapped: Database = {
    ...db,
    all: (sql, params) => time(sql, params, () => db.all(sql, params)),
    get: (sql, params) => time(sql, params, () => db.get(sql, params)),
    run: (sql, params) => time(sql, params, () => db.run(sql, params)),
    transaction: (fn) => db.transaction(() => fn(wrapped)),
  };
  return {
    db: wrapped,
    take() {
      const out = [...stats.values()];
      stats = new Map();
      return out;
    },
  };
}

// ---------------------------------------------------------------- seeding

function seed(db: Database) {
  const rand = mulberry32(16);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const t0 = performance.now();
  const at = iso(NOW - 400 * DAY);

  const providers = Array.from({ length: SIZES.providers }, (_, i) => ({ id: `prov-${i}`, identifier: `provider-${i}` }));
  const models = Array.from({ length: SIZES.models }, (_, i) => {
    const p = providers[i % providers.length]!;
    return { id: `model-${i}`, provider: p, modelId: `model-${i}-${['chat', 'mini', 'large', 'embed'][i % 4]}` };
  });
  const users = Array.from({ length: SIZES.users }, (_, i) => `user-${i}`);
  const keys = Array.from({ length: SIZES.keys }, (_, i) => ({ id: `key-${i}`, user: users[i % users.length]! }));

  db.transaction((tx) => {
    for (const p of providers) {
      tx.run('INSERT INTO providers (id, name, identifier, kind, endpoint, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [p.id, `Provider ${p.identifier}`, p.identifier, 'openai_compatible', 'http://127.0.0.1:1/v1', 100 + (Number(p.id.slice(5)) % 7), at, at]);
    }
    for (const m of models) {
      tx.run(`INSERT INTO models (id, provider_id, provider_model_id, display_name, capabilities, enabled, availability, source, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 1, 'AVAILABLE', 'DISCOVERED', ?, ?)`,
        [m.id, m.provider.id, m.modelId, m.modelId.replace(/-/g, ' '), m.modelId.endsWith('embed') ? '["EMBEDDINGS"]' : '["CHAT","STREAMING"]', at, at]);
    }
    for (const u of users) {
      tx.run(`INSERT INTO users (id, username, display_name, password_hash, status, created_at, updated_at, password_changed_at) VALUES (?, ?, ?, 'x', ?, ?, ?, ?)`,
        [u, u, u, u === 'user-0' ? 'DISABLED' : 'ACTIVE', at, at, at]);
      if (u === 'user-1') tx.run(`INSERT INTO user_roles (user_id, role_id, assigned_at) VALUES (?, 'ADMIN', ?)`, [u, at]);
    }
    keys.forEach((k, i) => {
      const expires = i % 5 === 0 ? null : iso(NOW + ((i % 90) - 30) * DAY);
      tx.run(`INSERT INTO api_keys (id, name, prefix, secret_hash, allowed_models, created_by, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
        [k.id, `key ${i}`, `crk_${i.toString(16).padStart(8, '0')}`, `hash-${i}`, k.user, at, expires, i % 11 === 0 ? at : null]);
    });
  });

  const STATUSES = ['COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED'];
  const BATCH = 20_000;
  for (let start = 0; start < SIZES.requests; start += BATCH) {
    db.transaction((tx) => {
      for (let i = start; i < Math.min(SIZES.requests, start + BATCH); i++) {
        const k = pick(keys);
        const m = pick(models);
        const status = pick(STATUSES);
        // 30 days of history, newest last.
        const t = NOW - 30 * DAY + Math.floor((i / SIZES.requests) * 30 * DAY);
        tx.run(`INSERT INTO requests (id, received_at, completed_at, status, endpoint, stream, api_key_id, user_id, requested_model, model_ref, provider_id,
                  duration_ms, http_status, attempts, input_tokens, output_tokens, usage_source, cost_usd)
                VALUES (?, ?, ?, ?, '/v1/chat/completions', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'reported', ?)`,
          [`req-${i.toString().padStart(8, '0')}`, iso(t), iso(t + 800), status, i % 3 === 0 ? 1 : 0, k.id, k.user, m.modelId,
            `${m.provider.identifier}/${m.modelId}`, m.provider.id, 200 + (i % 3000), status === 'COMPLETED' ? 200 : 502,
            100 + (i % 900), 50 + (i % 400), 0.0001 * (i % 50)]);
      }
    });
  }

  // Hourly usage per key and model: a few hundred combinations active each hour.
  const combos = Array.from({ length: 30 }, () => ({ k: pick(keys), m: pick(models) }));
  for (let d = 0; d < SIZES.usageDays; d++) {
    db.transaction((tx) => {
      for (let h = 0; h < 24; h++) {
        const hour = iso(NOW - (d * 24 + h) * 3_600_000).slice(0, 13) + ':00:00.000Z';
        for (const c of combos) {
          tx.run(`INSERT OR IGNORE INTO usage_records (hour, api_key_id, user_id, model_ref, provider_id, requests, errors, input_tokens, output_tokens, cost_usd, duration_ms)
                  VALUES (?, ?, ?, ?, ?, 12, 1, 4000, 2000, 0.02, 9000)`,
            [hour, c.k.id, c.k.user, `${c.m.provider.identifier}/${c.m.modelId}`, c.m.provider.id]);
        }
      }
    });
  }

  const ACTIONS = ['LOGIN_SUCCESS', 'LOGIN_FAILED', 'API_KEY_CREATED', 'PROVIDER_UPDATED', 'MODEL_UPDATED', 'SETTINGS_CHANGED', 'ROUTING_UPDATED'];
  for (let start = 0; start < SIZES.audit; start += BATCH) {
    db.transaction((tx) => {
      for (let i = start; i < Math.min(SIZES.audit, start + BATCH); i++) {
        const t = NOW - 90 * DAY + Math.floor((i / SIZES.audit) * 90 * DAY);
        const action = pick(ACTIONS);
        tx.run(`INSERT INTO audit_log (id, timestamp, actor_id, actor_name, action, resource, resource_id, result, ip, request_id, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [`aud-${i.toString().padStart(8, '0')}`, iso(t), pick(users), pick(users), action, action.split('_')[0]!.toLowerCase(), `res-${i % 5000}`,
            action === 'LOGIN_FAILED' ? 'FAILURE' : 'SUCCESS', `10.0.${i % 255}.${i % 200}`, `req_${i.toString(16)}`, JSON.stringify({ note: `change ${i}`, n: i % 100 })]);
      }
    });
  }
  db.exec('ANALYZE');
  return { seconds: (performance.now() - t0) / 1000, keys, models, providers };
}

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- scenarios

const dir = mkdtempSync(join(tmpdir(), 'clawrouter-bench-'));
const path = join(dir, 'bench.sqlite');
const base = openSqlite({ path });
runMigrations(base, migrations);
console.log(`Seeding ${JSON.stringify(SIZES)} …`);
const seeded = seed(base);
console.log(`Seeded in ${seeded.seconds.toFixed(1)} s (${path})\n`);

const p = profile(base);
const requests = createSqliteRequestRepository(p.db);
const audit = createSqliteAuditRepository(p.db);
const models = createSqliteModelRepository(p.db);
const apiKeys = createApiKeyService({ db: p.db, audit: { record() {} } as unknown as AuditService, now: () => new Date(NOW) });
const k = seeded.keys[7]!.id;
const m = seeded.models[42]!;
const day = (n: number) => iso(NOW - n * DAY);

const scenarios: [string, () => unknown][] = [
  ['requests: first page, no filter', () => requests.list({ limit: 50, offset: 0 })],
  ['requests: page 200', () => requests.list({ limit: 50, offset: 50 * 199 })],
  ['requests: status FAILED', () => requests.list({ status: 'FAILED', limit: 50, offset: 0 })],
  ['requests: problems only', () => requests.list({ problemsOnly: true, limit: 50, offset: 0 })],
  ['requests: one API key', () => requests.list({ apiKeyId: k, limit: 50, offset: 0 })],
  ['requests: one model', () => requests.list({ model: m.modelId, limit: 50, offset: 0 })],
  ['requests: one provider', () => requests.list({ providerId: m.provider.id, limit: 50, offset: 0 })],
  ['requests: last 24 hours', () => requests.list({ from: day(1), limit: 50, offset: 0 })],
  ['requests: key + last 7 days', () => requests.list({ apiKeyId: k, from: day(7), limit: 50, offset: 0 })],
  ['requests: detail', () => requests.get('req-00250000')],
  ['usage: totals, 30 days', () => requests.usageTotals(day(30), iso(NOW))],
  ['usage: daily series, 30 days', () => requests.usageSeries({ from: day(30), to: iso(NOW), bucket: 'day', groupBy: 'model' })],
  ['usage: hourly series, 24 hours', () => requests.usageSeries({ from: day(1), to: iso(NOW), bucket: 'hour', groupBy: 'model' })],
  ['usage: by model, 30 days', () => requests.usageBreakdown({ from: day(30), to: iso(NOW), bucket: 'day', groupBy: 'model' })],
  ['usage: by user, 365 days', () => requests.usageBreakdown({ from: day(365), to: iso(NOW), bucket: 'day', groupBy: 'user' })],
  ['audit: first page', () => audit.search({ limit: 50, offset: 0 })],
  ['audit: one action', () => audit.search({ action: 'SETTINGS_CHANGED', limit: 50, offset: 0 })],
  ['audit: one resource id', () => audit.search({ resourceId: 'res-1234', limit: 50, offset: 0 })],
  ['audit: one request id', () => audit.search({ requestId: 'req_3039', limit: 50, offset: 0 })],
  ['audit: actor text', () => audit.search({ actor: 'user-17', limit: 50, offset: 0 })],
  ['audit: free text', () => audit.search({ q: 'change 4242', limit: 50, offset: 0 })],
  ['audit: last day', () => audit.search({ from: day(1), limit: 50, offset: 0 })],
  ['audit: resource filter options', () => audit.resources()],
  ['models: first page', () => models.query({ limit: 50, offset: 0 })],
  ['models: search text', () => models.query({ q: 'model 42', limit: 50, offset: 0 })],
  ['models: one provider', () => models.query({ providerId: m.provider.id, limit: 50, offset: 0 })],
  ['models: chat capability', () => models.query({ capability: 'CHAT', usableOnly: true, limit: 50, offset: 0 })],
  ['models: whole registry (routing)', () => models.query({ limit: 100_000, offset: 0 })],
  ['api keys: beyond 7-day lifetime', () => apiKeys.beyondLifetime(7 * 24, { page: 1, pageSize: 10 })],
  ['api keys: authenticate by hash', () => p.db.get('SELECT * FROM api_keys WHERE secret_hash = ?', ['hash-500'])],
];

const results: { name: string; median: number; slowest: Stat[] }[] = [];
for (const [name, fn] of scenarios) {
  fn(); // warm the statement cache and pages
  p.take();
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    fn();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const stats = p.take().sort((a, b) => b.ms - a.ms);
  results.push({ name, median: times[Math.floor(times.length / 2)]!, slowest: stats });
}

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
console.log(`${pad('scenario', 40)} ${'median ms'.padStart(10)}  plan of the slowest statement`);
for (const r of results) {
  const top = r.slowest[0];
  const plan = top ? (base.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${top.sql}`, top.params).map((x) => x.detail).join(' | ')) : '';
  console.log(`${pad(r.name, 40)} ${r.median.toFixed(2).padStart(10)}  ${plan.replace(/\s+/g, ' ').slice(0, 150)}`);
}

base.close();
if (process.argv.includes('--keep')) console.log(`\nKept ${path}`);
else rmSync(dir, { recursive: true, force: true });
