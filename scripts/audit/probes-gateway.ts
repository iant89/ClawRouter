/**
 * Audit probes, part 2: the /v1 gateway, limits and quotas, routing, MCP, client
 * notices, captures, SSRF, the live channel, two-factor sign-in, session revocation,
 * HTML injection in the console, and the slow, time-based checks.
 */
import { Client, chat, items, sleep, step, totp, v1 } from './lib.ts';
import { PW, type World } from './probes-web.ts';

const MINI = 'mock/gpt-4o-mini';
const FULL = 'mock/gpt-4o';

async function key(w: World, name: string, extra: Record<string, unknown> = {}) {
  const res = await w.admin.call('/api/api-keys', { json: { name, expiry: { type: 'never' }, ...extra } });
  if (res.status !== 201) throw new Error(`key ${name}: ${res.status} ${res.text}`);
  w.planted.push(res.data.secret);
  return { id: res.data.key.id as string, secret: res.data.secret as string };
}
const settings = (w: World, values: Record<string, number | null>) => w.admin.call('/api/settings', { method: 'PUT', json: { values } });

export async function gateway(w: World) {
  const { r, base } = w;
  const none = await v1(base, '/v1/models', null);
  const nb = await none.json();
  r.check('G1', 'Gateway', 'no key: 401 in the OpenAI error format', none.status === 401 && typeof nb?.error?.message === 'string' && 'type' in nb.error, `${none.status}`);
  r.check('G2', 'Gateway', 'a wrong key is refused', (await v1(base, '/v1/models', `crk_${'x'.repeat(60)}`)).status === 401);
  r.check('G3', 'Gateway', 'a key in the query string is not accepted', (await fetch(`${base}/v1/models?api_key=${w.gatewayKey}`)).status === 401);
  r.check('G4', 'Gateway', 'a session cookie does not open /v1 (keys only)', (await v1(base, '/v1/models', null, undefined, { cookie: w.admin.cookieHeader() })).status === 401);
  const c = await v1(base, '/v1/chat/completions', w.gatewayKey, chat(MINI));
  const cb = await c.json();
  r.check('G5', 'Gateway', 'chat completions work end to end', c.status === 200 && typeof cb?.choices?.[0]?.message?.content === 'string', `${c.status}`);
  const s = await v1(base, '/v1/chat/completions', w.gatewayKey, { ...chat(MINI), stream: true });
  const st = await s.text();
  r.check('G6', 'Gateway', 'streaming answers server-sent events ending in [DONE]', s.status === 200 && /^data: /m.test(st) && st.includes('data: [DONE]'), s.headers.get('content-type') ?? '');
  const e = await v1(base, '/v1/embeddings', w.gatewayKey, { model: 'mock/text-embedding-3-small', input: 'hello' });
  r.check('G7', 'Gateway', 'embeddings work', e.status === 200 && Array.isArray((await e.json())?.data?.[0]?.embedding));
  const rs = await v1(base, '/v1/responses', w.gatewayKey, { model: MINI, input: 'Hello' });
  r.check('G8', 'Gateway', '/v1/responses works', rs.status === 200 && (await rs.json())?.object === 'response');
  const unknown = await v1(base, '/v1/chat/completions', w.gatewayKey, chat('mock/no-such-model'));
  r.check('G9', 'Gateway', 'an unknown model is a 4xx in the OpenAI format, not a 500', unknown.status >= 400 && unknown.status < 500, `${unknown.status}`);

  const mini = await key(w, 'mini-only', { allowedModels: [MINI] });
  const ok = await v1(base, '/v1/chat/completions', mini.secret, chat(MINI));
  const no = await v1(base, '/v1/chat/completions', mini.secret, chat(FULL));
  const listed = (await (await v1(base, '/v1/models', mini.secret)).json()).data?.map((m: { id: string }) => m.id);
  r.check('G10', 'Gateway', 'a key limited to one model cannot use another, and lists only it', ok.status === 200 && no.status === 403 && listed?.join() === MINI, `${ok.status}/${no.status} ${listed}`);
  await w.admin.call(`/api/api-keys/${mini.id}`, { method: 'DELETE' });
  r.check('G11', 'Gateway', 'a revoked key stops working at once', (await v1(base, '/v1/models', mini.secret)).status === 401);
  const soon = await w.admin.call('/api/api-keys', { json: { name: 'expiring', expiry: { type: 'at', at: new Date(Date.now() + 2500).toISOString() } } });
  const before = (await v1(base, '/v1/models', soon.data.secret)).status;
  await sleep(3000);
  const after = (await v1(base, '/v1/models', soon.data.secret)).status;
  r.check('G12', 'Gateway', 'an expired key is refused', before === 200 && after === 401, `${before} → ${after}`);
  const dana = w.users.dana!;
  const dk = await dana.client.call('/api/me/api-keys', { json: { name: 'dana-2', expiry: { type: 'after', hours: 2 } } });
  const s1 = (await v1(base, '/v1/models', dk.data.secret)).status;
  await w.admin.call(`/api/users/${dana.id}`, { method: 'PATCH', json: { status: 'DISABLED' } });
  const s2 = (await v1(base, '/v1/models', dk.data.secret)).status;
  const signedOut = (await dana.client.call('/api/auth/session')).status;
  await w.admin.call(`/api/users/${dana.id}`, { method: 'PATCH', json: { status: 'ACTIVE' } });
  const s3 = (await v1(base, '/v1/models', dk.data.secret)).status;
  r.check('G13', 'Gateway', "a disabled user's keys are suspended and their sessions end; keys work again when re-enabled", s1 === 200 && s2 === 401 && signedOut === 401 && s3 === 200, `${s1} → ${s2} (session ${signedOut}) → ${s3}`);
  await dana.client.login('dana', dana.password);
}

export async function input(w: World) {
  const { r, base } = w;
  const big = await v1(base, '/v1/chat/completions', w.gatewayKey, JSON.stringify(chat(MINI, 'x'.repeat(26 * 1024 * 1024))));
  const bb = await big.json().catch(() => null);
  r.check('I1', 'Input', '/v1 refuses bodies over 25 MB with 413, in the OpenAI format', big.status === 413 && bb?.error?.type === 'invalid_request_error', `${big.status}`);
  const adminBig = await w.admin.call('/api/auth/theme', { method: 'PUT', body: JSON.stringify({ theme: 'dark', pad: 'x'.repeat(70 * 1024) }), headers: { 'content-type': 'application/json' } });
  r.check('I2', 'Input', '/api refuses bodies over 64 KB with 413', adminBig.status === 413, `${adminBig.status}`);
  const stream = new ReadableStream({ start(ctl) { for (let i = 0; i < 80; i++) ctl.enqueue(new TextEncoder().encode('x'.repeat(1024))); ctl.close(); } });
  const chunked = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: stream, duplex: 'half' } as RequestInit);
  r.check('I3', 'Input', 'a chunked body without Content-Length is capped too', chunked.status === 413, `${chunked.status}`);
  const deep = await v1(base, '/v1/chat/completions', w.gatewayKey, `${'['.repeat(100_000)}${']'.repeat(100_000)}`);
  r.check('I4', 'Input', 'deeply nested JSON is a 400, not a crash', deep.status === 400, `${deep.status}`);
  const bad = await v1(base, '/v1/chat/completions', w.gatewayKey, { model: MINI, messages: 'not a list', n: 5, temperature: 'hot' });
  r.check('I5', 'Input', 'invalid fields are refused with 400', bad.status === 400);
  const extra = await w.admin.call('/api/auth/theme', { method: 'PUT', json: { theme: 'dark', isAdmin: true } });
  r.check('I6', 'Input', 'unknown fields are refused on /api', extra.status === 400, `${extra.status}`);
  const search = await w.admin.call(`/api/audit?q=${encodeURIComponent("' OR 1=1 --")}`);
  r.check('I7', 'Input', 'injection-shaped search text is a value, not SQL', search.status === 200 && items(search.data).length === 0, `${search.status}`);
  r.check('I8', 'Input', 'the server is still up', (await fetch(`${base}/api/health/live`)).status === 200);
}

export async function limits(w: World) {
  const { r, base } = w;
  for (const [id, path, body] of [['R1', '/v1/chat/completions', chat(MINI)], ['R2', '/v1/embeddings', { model: 'mock/text-embedding-3-small', input: 'x' }], ['R3', '/v1/responses', { model: MINI, input: 'x' }]] as const) {
    const k = await key(w, `limit ${path}`, { rateLimit: { window: 'minute', requests: 2, tokens: null, bucket: null } });
    const codes: number[] = [];
    let retry = '';
    for (let i = 0; i < 3; i++) {
      const res = await v1(base, path, k.secret, body);
      codes.push(res.status);
      if (res.status === 429) retry = res.headers.get('retry-after') ?? '';
    }
    r.check(id, 'Rate limits', `${path}: a 2/minute key limit refuses the 3rd with 429 and Retry-After`, codes.join() === '200,200,429' && !!retry, `${codes.join()} retry-after=${retry}`);
  }
  const bucket = await key(w, 'bucket', { rateLimit: { window: 'minute', requests: null, tokens: null, bucket: { capacity: 2, refillAmount: 1, refillEverySeconds: 60 } } });
  const bc: number[] = [];
  for (let i = 0; i < 3; i++) bc.push((await v1(base, '/v1/chat/completions', bucket.secret, chat(MINI))).status);
  r.check('R4', 'Rate limits', 'a token bucket of 2 refuses the 3rd request in a burst', bc.join() === '200,200,429', bc.join());
  const cfg = (await w.admin.call('/api/rate-limits')).data;
  const n = cfg?.invalidKeysPerIp ?? 20;
  let blockedAt = -1;
  for (let i = 0; i < n + 30; i++) {
    if ((await v1(base, '/v1/models', `crk_${'y'.repeat(60)}`)).status === 429) {
      blockedAt = i + 1;
      break;
    }
  }
  const good = await v1(base, '/v1/models', w.gatewayKey);
  r.check('R5', 'Rate limits', `an address over ${n} wrong keys a minute is blocked, even with a valid key`, blockedAt > 0 && good.status === 429, `blocked after ${blockedAt} more; valid key then ${good.status}`);
  const viewerUsage = await w.users.victor!.client.call('/api/rate-limits/usage');
  const adminUsage = await w.admin.call('/api/rate-limits/usage');
  r.check('R6', 'Privacy', 'rate-limit usage shows client addresses to administrators only (Viewers see "(hidden)")', !viewerUsage.text.includes('127.0.0.1') && viewerUsage.text.includes('(hidden)') && adminUsage.text.includes('127.0.0.1'), `${viewerUsage.status}`);
  w.r.note('R7', 'Rate limits', 'the invalid-key block lasts a minute', 'later sections wait for it to clear');
  await sleep(61_000);
}

export async function quotas(w: World) {
  const { r, base } = w;
  const dm = w.users.dmitri!;
  await w.admin.call(`/api/users/${dm.id}/quota`, { method: 'PUT', json: { quota: { enabled: true, unit: 'requests', amount: 2, period: 'day', resetHour: 0, resetWeekday: 1, resetDayOfMonth: 1, timeZone: 'UTC' } } });
  const k = await dm.client.call('/api/me/api-keys', { json: { name: 'quota-key', expiry: { type: 'after', hours: 1 } } });
  const codes: number[] = [];
  for (let i = 0; i < 3; i++) codes.push((await v1(base, '/v1/chat/completions', k.data.secret, chat(MINI))).status);
  r.check('Q1', 'Quotas', 'a 2-requests-a-day quota refuses the 3rd request', codes.join() === '200,200,429', codes.join());
  const mine = (await dm.client.call('/api/auth/quota')).data;
  r.check('Q2', 'Quotas', 'the user sees their own usage against the quota', mine?.usage?.used === 2 || mine?.used === 2 || JSON.stringify(mine).includes('"used":2'), JSON.stringify(mine).slice(0, 120));
  await settings(w, { quotasEnabled: 0 });
  const off = (await v1(base, '/v1/chat/completions', k.data.secret, chat(MINI))).status;
  await settings(w, { quotasEnabled: null });
  r.check('Q3', 'Quotas', 'turning quotas off for everyone lets requests through', off === 200, `${off}`);
}

export async function routing(w: World) {
  const { r, base, admin } = w;
  const dead = await admin.call('/api/providers', { json: { name: 'Dead', identifier: 'dead', kind: 'openai_compatible', endpoint: 'http://127.0.0.1:9/v1', apiKey: 'sk-dead-provider-placeholder-000', priority: 1 } });
  await admin.call('/api/models', { json: { providerId: dead.data?.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT'] } });
  const rt = (await admin.call('/api/routing')).data;
  await admin.call('/api/routing', { method: 'PUT', json: { version: rt.version, defaultPolicy: rt.defaultPolicy, aliases: [{ name: 'smart', description: 'audit', enabled: true, capabilities: ['CHAT'], policy: null, targets: [{ modelRef: 'dead/gpt-4o-mini', priority: 1, weight: 1 }, { modelRef: MINI, priority: 2, weight: 1 }] }] } });
  const res = await v1(base, '/v1/chat/completions', w.gatewayKey, chat('smart'));
  const body = await res.json();
  r.check('F1', 'Routing', 'an alias fails over from a dead provider to the next target', res.status === 200 && body?.model === MINI, `${res.status} ${body?.model}`);
  r.check('F2', 'Notices', 'a failover notice is sent in the header', /failover/.test(res.headers.get('x-clawrouter-notices') ?? ''));
  await sleep(300);
  const last = items((await admin.call('/api/requests?pageSize=3')).data)[0];
  const d = (await admin.call(`/api/requests/${last?.id}`)).data;
  const att = d?.attemptLog ?? [];
  r.check('F3', 'Requests', 'request history records every attempt', att.length >= 2 && att.at(-1)?.outcome === 'ok', att.map((a: { modelRef: string; outcome: string }) => `${a.modelRef}:${a.outcome}`).join(', '));
  r.check('F4', 'Requests', 'request history holds metadata only, never the prompt or the reply', !JSON.stringify(d).includes('Hello'), '');
  const usage = await admin.call('/api/usage');
  r.check('F5', 'Usage', 'usage is recorded with tokens', usage.status === 200 && /"(inputTokens|totalTokens|tokens)":\s*[1-9]/.test(usage.text), usage.text.slice(0, 100));
  await admin.call(`/api/providers/${w.providerId}`, { method: 'PATCH', json: { maxKeyLifetimeHours: 1 } });
  const never = await admin.call('/api/api-keys', { json: { name: 'never for limited', allowedModels: [MINI], expiry: { type: 'never' } } });
  const longer = await admin.call('/api/api-keys', { json: { name: 'two hours for limited', allowedModels: [MINI], expiry: { type: 'after', hours: 2 } } });
  const fits = await admin.call('/api/api-keys', { json: { name: 'one hour for limited', allowedModels: [MINI], expiry: { type: 'after', hours: 1 } } });
  r.check('F6', 'Key lifetime', "a provider's maximum key lifetime refuses longer keys for its models at creation", never.status === 400 && longer.status === 400 && fits.status === 201, `${never.status}/${longer.status}/${fits.status}`);
  r.note('F7', 'Key lifetime', 'refusal at use (403 key_too_old) for keys older than the limit', 'needs a key older than the 1-hour minimum; covered by packages/api/test/key-lifetime-api.test.ts with a fake clock');
  await admin.call(`/api/providers/${w.providerId}`, { method: 'PATCH', json: { maxKeyLifetimeHours: null } });
}

export async function mcp(w: World) {
  const { r, base } = w;
  const k = await key(w, 'mcp-key', { mcpAccess: true });
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'audit', version: '1' } } };
  const off = await v1(base, '/v1/mcp', k.secret, init);
  const anon = await fetch(`${base}/v1/mcp`, { method: 'POST' });
  r.check('M1', 'MCP', 'off by default: /v1/mcp is a 404, with or without a key', off.status === 404 && anon.status === 404, `${off.status}/${anon.status}`);
  await settings(w, { mcpEnabled: 1 });
  const on = await v1(base, '/v1/mcp', k.secret, init);
  const plain = await v1(base, '/v1/mcp', w.gatewayKey, init);
  r.check('M2', 'MCP', 'when on, a key needs its own MCP access', on.status === 200 && plain.status === 403, `${on.status}/${plain.status}`);
  const tools: string[] = ((await (await v1(base, '/v1/mcp', k.secret, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json())?.result?.tools ?? []).map((t: { name: string }) => t.name);
  r.check('M3', 'MCP', 'every tool only reads', tools.length > 0 && !tools.some((n) => /create|update|delete|set_|revoke|write|disable/i.test(n)), tools.join(', '));
  let leak = false;
  for (const n of tools) {
    const t = await (await v1(base, '/v1/mcp', k.secret, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: n, arguments: {} } })).text();
    if (w.planted.some((s) => s && t.includes(s)) || t.includes(w.providerKey)) leak = true;
  }
  r.check('M4', 'MCP', 'no tool returns a key or a password', !leak, `${tools.length} tools called`);
  const dana = w.users.dana!;
  const dk = await dana.client.call('/api/me/api-keys', { json: { name: 'dana-mcp', expiry: { type: 'after', hours: 1 }, mcpAccess: true } });
  const theirs: string[] = ((await (await v1(base, '/v1/mcp', dk.data.secret, { jsonrpc: '2.0', id: 4, method: 'tools/list' })).json())?.result?.tools ?? []).map((t: { name: string }) => t.name);
  const audit = await (await v1(base, '/v1/mcp', dk.data.secret, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'search_audit', arguments: {} } })).json();
  r.check('M5', 'MCP', "tools follow the key owner's permissions: a Developer is not offered, and cannot call, the audit search", theirs.length > 0 && !theirs.includes('search_audit') && !!audit?.error, `${theirs.join(', ')}; call: ${audit?.error?.message ?? 'answered'}`);
  await settings(w, { mcpEnabled: 0 });
}

export async function notices(w: World) {
  const { r, base, admin } = w;
  const a = await admin.call('/api/announcements', { json: { message: 'Line one\r\nX-Injected: yes\r\n\r\n<b>bold</b> ünïcödé', icon: '📢', frequency: 'every_request', channel: 'both', timeZone: 'UTC' } });
  r.check('N1', 'Notices', 'line breaks in an announcement are stored as spaces', a.status === 201 && !/[\r\n]/.test(a.data?.message ?? ''), JSON.stringify(a.data?.message));
  const k = await key(w, 'notice-key');
  const res = await v1(base, '/v1/chat/completions', k.secret, chat(MINI));
  const header = res.headers.get('x-clawrouter-notices') ?? '';
  const content: string = (await res.json())?.choices?.[0]?.message?.content ?? '';
  r.check('N2', 'Notices', 'the header is ASCII-only JSON and cannot inject headers', /^[\x20-\x7e]+$/.test(header) && !res.headers.get('x-injected'), header.slice(0, 80));
  r.check('N3', 'Notices', 'the reply starts with the notice line and a blank line', /^📢 ClawRouter: .+\n\n/.test(content), JSON.stringify(content.slice(0, 60)));
  const tools = await v1(base, '/v1/chat/completions', k.secret, { ...chat(MINI, 'weather?'), tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object', properties: {} } } }] });
  const tm = (await tools.json())?.choices?.[0]?.message;
  r.check('N4', 'Notices', 'a request with tools never gets reply text written into it', !String(tm?.content ?? '').includes('ClawRouter:'), JSON.stringify(tm).slice(0, 80));
  await admin.call(`/api/api-keys/${k.id}`, { method: 'PATCH', json: { replyNotices: false } });
  const clean = (await (await v1(base, '/v1/chat/completions', k.secret, chat(MINI))).json())?.choices?.[0]?.message?.content;
  r.check('N5', 'Notices', "a key's replyNotices switch keeps replies clean", !String(clean).includes('ClawRouter:'));
  await settings(w, { noticeHeaderEnabled: 0 });
  const nh = await v1(base, '/v1/chat/completions', k.secret, chat(MINI));
  await nh.text();
  await settings(w, { noticeHeaderEnabled: null });
  r.check('N6', 'Notices', 'the header setting turns the header off', !nh.headers.get('x-clawrouter-notices'));
  const once = await admin.call('/api/announcements', { json: { message: 'Only once', icon: '💡', frequency: 'once', channel: 'header', timeZone: 'UTC' } });
  const k2 = await key(w, 'once-key');
  const h1 = (await v1(base, '/v1/chat/completions', k2.secret, chat(MINI))).headers.get('x-clawrouter-notices') ?? '';
  const h2 = (await v1(base, '/v1/chat/completions', k2.secret, chat(MINI))).headers.get('x-clawrouter-notices') ?? '';
  r.check('N7', 'Notices', 'a "once per user" announcement is sent once', h1.includes('Only once') && !h2.includes('Only once'), `${h1.includes('Only once')}/${h2.includes('Only once')}`);
  const expiring = await admin.call('/api/announcements', { json: { message: 'Short lived', icon: '⏰', frequency: 'every_request', channel: 'header', timeZone: 'UTC', expiresAt: new Date(Date.now() + 2000).toISOString() } });
  await sleep(7500);
  const list = JSON.stringify((await admin.call('/api/announcements')).data);
  r.check('N8', 'Notices', 'an expired announcement deletes itself', expiring.status === 201 && !list.includes('Short lived'), `${expiring.status}`);
  for (const x of [a, once]) if (x.data?.id) await admin.call(`/api/announcements/${x.data.id}`, { method: 'DELETE' });
}

export async function captures(w: World) {
  const { r, base, admin } = w;
  const st = (await admin.call('/api/captures/state')).data;
  const early = await admin.call('/api/captures/manual', { json: { count: 1, minutes: 5 } });
  r.check('T1', 'Captures', 'off by default; a manual capture cannot start while off', st?.enabled === false && early.status === 409, `${st?.enabled} ${early.status}`);
  await settings(w, { capturesEnabled: 1 });
  await admin.call('/api/captures/manual', { json: { count: 1, minutes: 5 } });
  const k = await key(w, 'capture-key');
  await (await v1(base, '/v1/chat/completions', k.secret, { model: MINI, messages: [{ role: 'user', content: 'q1 Grüße 🎉' }, { role: 'assistant', content: '📢 ClawRouter: Old announcement.\n\nThe real earlier answer.' }, { role: 'user', content: 'q2' }] })).text();
  await sleep(300);
  const c = (await admin.call(`/api/captures/${items((await admin.call('/api/captures')).data)[0]?.id}`)).data;
  const text = JSON.stringify(c);
  r.check('T2', 'Captures', 'a manual capture records the next request', !!c?.exchanges?.length);
  r.check('T3', 'Captures', 'no credential in a capture', !text.includes(w.providerKey) && !text.includes(k.secret) && /"authorization":"\[REDACTED\]"/.test(text));
  r.check('T4', 'Captures', 'whole bodies with emoji are not marked truncated', c?.client?.request?.body?.truncated === false && c?.exchanges?.[0]?.request?.body?.truncated === false);
  const sent = c?.exchanges?.[0]?.request?.body?.text ?? '';
  r.check('T5', 'Notices', 'notice lines are removed from conversations sent back, before the provider sees them', sent.includes('The real earlier answer') && !sent.includes('Old announcement'), sent.slice(0, 120));
  const ex = await admin.call('/api/captures/export', { json: { ids: [c.id], maskText: true } });
  r.check('T6', 'Captures', 'a masked export hides message text', ex.status === 200 && !ex.text.includes('q1 Grüße') && !ex.text.includes('real earlier answer'), `${ex.status}`);
  await settings(w, { capturesEnabled: 0 });
}

export async function ssrf(w: World) {
  const { r, admin } = w;
  const refused: string[] = [];
  const accepted: string[] = [];
  const cases = ['http://169.254.169.254/latest', 'http://2852039166/latest', 'http://0xA9FEA9FE/latest', 'http://0251.0376.0251.0376/latest', 'http://169.254.169.254./latest', 'https://[::ffff:a9fe:a9fe]/latest', 'https://[::ffff:169.254.169.254]/latest', 'https://metadata.google.internal./x', 'http://METADATA.GOOGLE.INTERNAL/x', 'http://[fd00:ec2::254]/x', 'http://[fe80::1]/x', 'file:///etc/passwd', 'gopher://x/', 'http://api.example.com/v1', 'https://user:pw@example.com/v1', 'https://example.com/v1?key=abc'];
  for (const ep of cases) {
    const res = await admin.call('/api/providers', { json: { name: 'T', identifier: `ssrf${Math.floor(Math.random() * 1e9)}`, kind: 'openai_compatible', endpoint: ep, apiKey: 'sk-placeholder-0000000000' } });
    (res.status === 400 ? refused : accepted).push(ep);
    if (res.data?.id) await admin.call(`/api/providers/${res.data.id}`, { method: 'DELETE' });
  }
  r.check('Z1', 'SSRF', 'metadata, link-local, non-HTTP, credentials-in-URL, query strings and public plain HTTP are refused', accepted.length === 0, accepted.join(', ') || `${cases.length} refused`);
  const local = await admin.call('/api/providers', { json: { name: 'Local', identifier: 'localollama', kind: 'openai_compatible', endpoint: 'http://127.0.0.1:11434/v1', apiKey: 'sk-placeholder-0000000000' } });
  r.check('Z2', 'SSRF', 'local models stay possible (loopback over HTTP is accepted, on purpose)', local.status === 201);
  if (local.data?.id) await admin.call(`/api/providers/${local.data.id}`, { method: 'DELETE' });
  r.check('Z3', 'SSRF', 'only providers.write can set endpoints (a Viewer cannot)', (await w.users.victor!.client.call('/api/providers', { json: { name: 'x', identifier: 'xv', kind: 'openai', endpoint: 'https://example.com/v1' } })).status === 403);
}

function openSocket(base: string, headers: Record<string, string>) {
  return new Promise<{ status: 'open' | 'refused'; messages: string[]; close: () => void; closed: Promise<number> }>((resolve) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/ws`, { headers, tls: { rejectUnauthorized: false } } as unknown as string[]);
    const messages: string[] = [];
    let closedResolve: (code: number) => void = () => {};
    const closed = new Promise<number>((res) => (closedResolve = res));
    const t = setTimeout(() => resolve({ status: 'refused', messages, close: () => ws.close(), closed }), 3000);
    ws.onmessage = (e) => messages.push(String(e.data));
    ws.onopen = () => { clearTimeout(t); resolve({ status: 'open', messages, close: () => ws.close(), closed }); };
    ws.onerror = () => { clearTimeout(t); resolve({ status: 'refused', messages, close: () => {}, closed }); };
    ws.onclose = (e) => closedResolve(e.code);
  });
}

export async function realtime(w: World) {
  const { r, base, admin } = w;
  const origin = new URL(base).origin;
  const noCookie = await openSocket(base, { origin });
  const evil = await openSocket(base, { origin: 'https://evil.example', cookie: admin.cookieHeader() });
  r.check('W1', 'Real-time', 'the WebSocket needs a session and the same origin', noCookie.status === 'refused' && evil.status === 'refused', `${noCookie.status}/${evil.status}`);
  const viewer = await openSocket(base, { origin, cookie: w.users.victor!.client.cookieHeader() });
  const nobody = await openSocket(base, { origin, cookie: w.users.nora!.client.cookieHeader() });
  const ad = await openSocket(base, { origin, cookie: admin.cookieHeader() });
  await admin.call('/api/settings', { method: 'PUT', json: { values: { noticeIntervalMinutes: 31 } } });
  await admin.call(`/api/roles/${w.roles.Developers}`, { method: 'PATCH', json: { description: 'changed' } });
  await admin.call(`/api/users/${w.users.kim!.id}`, { method: 'PATCH', json: { displayName: 'Kim K' } });
  await new Client(base).login('admin', 'wrong password for the audit');
  await v1(base, '/v1/models', `crk_${'z'.repeat(60)}`);
  await sleep(1500);
  const names = (list: string[]) => list.map((m) => { try { return JSON.parse(m).type === 'event' ? JSON.parse(m).name : JSON.parse(m).type; } catch { return '?'; } });
  const vn = names(viewer.messages);
  r.check('W2', 'Real-time', 'a Viewer receives no settings, role or user events', !vn.some((n) => /settings|role|user\./.test(n)), vn.join(','));
  r.check('W3', 'Real-time', 'no event to a Viewer or a user without roles carries a client address', ![...viewer.messages, ...nobody.messages].some((m) => m.includes('127.0.0.1')), `${viewer.messages.length}+${nobody.messages.length} messages`);
  r.check('W4', 'Real-time', 'administrators do receive them', names(ad.messages).some((n) => /settings|role|user/.test(n)), names(ad.messages).join(','));
  const sid = items((await w.users.victor!.client.call('/api/auth/sessions')).data).find((s) => s.current)?.id;
  await admin.call(`/api/sessions/${sid}`, { method: 'DELETE' });
  const code = await Promise.race([viewer.closed, sleep(3000).then(() => -1)]);
  r.check('W5', 'Real-time', "revoking a user's session closes their live channel (4401)", code === 4401, `${code}`);
  for (const s of [nobody, ad]) s.close();
  await w.users.victor!.client.login('victor', w.users.victor!.password);
}

export async function twoFactor(w: World) {
  const { r, base, admin } = w;
  const victor = w.users.victor!;
  const setup = await victor.client.call('/api/auth/2fa/totp', { json: {} });
  const secret: string = setup.data?.secret;
  w.planted.push(secret);
  const conf = await victor.client.call('/api/auth/2fa/totp/confirm', { json: { code: totp(secret, step()) } });
  const codes: string[] = conf.data?.codes ?? [];
  w.planted.push(...codes);
  const c1 = new Client(base);
  const challenge = (await c1.login('victor', victor.password)).data?.twoFactor?.challenge;
  r.check('2F1', 'Two-factor', 'with an authenticator app enrolled, the password alone gives no session', conf.status === 200 && !!challenge && !c1.session());
  for (let i = 0; i < 5; i++) await c1.call('/api/auth/login/verify', { json: { challenge, method: 'totp', code: String(100000 + i) } });
  const burnt = await c1.call('/api/auth/login/verify', { json: { challenge, method: 'totp', code: totp(secret, step()) } });
  r.check('2F2', 'Two-factor', 'five wrong codes burn the challenge (the right code is then refused)', burnt.status === 401, `${burnt.status}`);
  await sleep(31_000 - (Date.now() % 30_000));
  const code = totp(secret, step());
  const c2 = new Client(base);
  const ok = await c2.call('/api/auth/login/verify', { json: { challenge: (await c2.login('victor', victor.password)).data?.twoFactor?.challenge, method: 'totp', code } });
  const c3 = new Client(base);
  const replay = await c3.call('/api/auth/login/verify', { json: { challenge: (await c3.login('victor', victor.password)).data?.twoFactor?.challenge, method: 'totp', code } });
  r.check('2F3', 'Two-factor', 'a code works once and is refused afterwards (no replay)', ok.status === 200 && replay.status === 401, `${ok.status}/${replay.status}`);
  const c4 = new Client(base);
  const ch4 = (await c4.login('victor', victor.password)).data?.twoFactor?.challenge;
  const rec1 = await c4.call('/api/auth/login/verify', { json: { challenge: ch4, method: 'recovery', code: codes[0] } });
  const c5 = new Client(base);
  const rec2 = await c5.call('/api/auth/login/verify', { json: { challenge: (await c5.login('victor', victor.password)).data?.twoFactor?.challenge, method: 'recovery', code: codes[0] } });
  r.check('2F4', 'Two-factor', 'a recovery code works once', rec1.status === 200 && rec2.status === 401, `${rec1.status}/${rec2.status}`);
  victor.client = c2;

  // Email codes over a real (local) SMTP server.
  await admin.call('/api/settings/mail', { method: 'PUT', json: { enabled: true, host: '127.0.0.1', port: w.smtp.port, security: 'none', username: 'mailer', password: 'mail-secret-123', from: 'ClawRouter <clawrouter@example.test>' } });
  await admin.call('/api/settings/sign-in', { method: 'PUT', json: { methods: { totp: true, email: true }, require: 'off' } });
  const kim = w.users.kim!;
  await kim.client.call('/api/auth/email', { method: 'PUT', json: { email: 'kim@example.test', password: kim.password } });
  await kim.client.call('/api/auth/2fa/email', { json: {} });
  const mailCode = () => /Your code: (\d{6})/.exec(w.smtp.messages.at(-1)?.text ?? '')?.[1] ?? '';
  const ec = await kim.client.call('/api/auth/2fa/email/confirm', { json: { code: mailCode() } });
  const k1 = new Client(base);
  const kch = (await k1.login('kim', kim.password)).data?.twoFactor;
  await k1.call('/api/auth/login/email-code', { json: { challenge: kch?.challenge } });
  const signInCode = mailCode();
  const resend = await k1.call('/api/auth/login/email-code', { json: { challenge: kch?.challenge } });
  const kok = await k1.call('/api/auth/login/verify', { json: { challenge: kch?.challenge, method: 'email', code: signInCode } });
  r.check('2F5', 'Two-factor', 'email codes arrive by SMTP and sign in; resending is limited', ec.status === 200 && kch?.emailHint === 'k•••@example.test' && resend.status === 429 && kok.status === 200, `${ec.status} ${kch?.emailHint} resend ${resend.status} verify ${kok.status}`);
  kim.client = k1;
  const mailSettings = await admin.call('/api/settings/mail');
  r.check('2F6', 'Two-factor', 'the SMTP password is write-only', !mailSettings.text.includes('mail-secret-123') && mailSettings.data?.passwordSet === true);
  // Requiring it for everyone also holds the administrator until they enrol, so enrol first.
  const adminSetup = await admin.call('/api/auth/2fa/totp', { json: {} });
  await admin.call('/api/auth/2fa/totp/confirm', { json: { code: totp(adminSetup.data?.secret, step()) } });
  w.planted.push(adminSetup.data?.secret);
  await admin.call('/api/settings/sign-in', { method: 'PUT', json: { methods: { totp: true, email: false }, require: 'everyone' } });
  const nora = w.users.nora!;
  const forced = await nora.client.call('/api/me/api-keys');
  const allowed = await nora.client.call('/api/auth/2fa');
  r.check('2F7', 'Two-factor', 'when required, a user without it is held at setup (403 two_factor_setup_required) but can still enrol', forced.status === 403 && forced.text.includes('two_factor_setup_required') && allowed.status === 200, `${forced.status}/${allowed.status}`);
  const off = await admin.call('/api/settings/sign-in', { method: 'PUT', json: { methods: { totp: true, email: false }, require: 'off' } });
  const dis = await admin.call('/api/auth/2fa/disable', { json: { method: 'totp', password: PW } });
  if (off.status !== 200 || dis.status !== 200) throw new Error(`could not undo the two-factor policy: ${off.status}/${dis.status}`);
  const escalate = await w.users.uma!.client.call(`/api/users/${victor.id}/two-factor/reset`, { json: {} });
  const reset = await admin.call(`/api/users/${victor.id}/two-factor/reset`, { json: {} });
  const after = new Client(base);
  const plainLogin = await after.login('victor', victor.password);
  r.check('2F8', 'Two-factor', "an administrator can reset a user's two-factor sign-in (a user manager without the user's permissions cannot)", escalate.status === 403 && reset.status === 200 && plainLogin.status === 200 && !!after.session(), `${escalate.status}/${reset.status}/${plainLogin.status}`);
  victor.client = after;
}

export async function sessions(w: World) {
  const { r, base } = w;
  const dana = w.users.dana!;
  const other = new Client(base);
  await other.login('dana', dana.password);
  const next = `${PW} renewed seven`;
  await dana.client.call('/api/auth/password', { json: { currentPassword: dana.password, newPassword: next } });
  dana.password = next;
  r.check('SS1', 'Sessions', "a password change ends the user's other sessions, keeps the current one", (await other.call('/api/auth/session')).status === 401 && (await dana.client.call('/api/auth/session')).status === 200);
  const third = new Client(base);
  await third.login('dana', dana.password);
  await w.admin.call(`/api/users/${dana.id}/password`, { json: { password: 'temporary pass 9 9999 zz' } });
  r.check('SS2', 'Sessions', 'an administrator password reset ends all their sessions', (await third.call('/api/auth/session')).status === 401 && (await dana.client.call('/api/auth/session')).status === 401);
  const t = new Client(base);
  await t.login('dana', 'temporary pass 9 9999 zz');
  await t.call('/api/auth/password', { json: { currentPassword: 'temporary pass 9 9999 zz', newPassword: dana.password } });
  dana.client = t;
}

export async function htmlInjection(w: World) {
  const { r, base, admin } = w;
  // Playwright is not a dependency (cloud sessions have it preinstalled): load it by name.
  interface Page { on(e: 'dialog', f: (d: { dismiss(): Promise<void> }) => void): void; goto(u: string): Promise<unknown>; waitForLoadState(s: string): Promise<void>; waitForTimeout(ms: number): Promise<void>; evaluate<T>(f: () => T): Promise<T> }
  interface Browser { newContext(o: { ignoreHTTPSErrors: boolean }): Promise<{ addCookies(c: { name: string; value: string; url: string }[]): Promise<void>; newPage(): Promise<Page> }>; close(): Promise<void> }
  let playwright: { chromium: { launch(): Promise<Browser> } };
  try {
    const name = 'playwright';
    playwright = (await import(name)) as typeof playwright;
  } catch {
    r.note('B1', 'HTML injection', 'browser check skipped', 'Playwright is not installed here');
    return;
  }
  const payload = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
  await admin.call('/api/announcements', { json: { message: `Hi ${payload}`, icon: '📢', frequency: 'once', channel: 'header', timeZone: 'UTC' } });
  await admin.call('/api/roles', { json: { name: `R ${payload}`.slice(0, 64), permissions: ['models.read'] } });
  await admin.call('/api/api-keys', { json: { name: `K ${payload}`.slice(0, 100), expiry: { type: 'never' } } });
  await admin.call(`/api/users/${w.users.kim!.id}`, { method: 'PATCH', json: { displayName: `Kim ${payload}`.slice(0, 128) } });
  const browser = await playwright.chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  await ctx.addCookies([...admin.cookies].map(([name, value]) => ({ name, value, url: base })));
  const page = await ctx.newPage();
  let dialogs = 0;
  page.on('dialog', (d) => { dialogs += 1; void d.dismiss(); });
  const ran: string[] = [];
  for (const path of ['/announcements', '/roles', '/api-access', '/users', '/audit']) {
    await page.goto(base + path);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(400);
    const x = await page.evaluate(() => (window as unknown as { __xss?: number }).__xss);
    if (x !== undefined) ran.push(`${path}: ${x}`);
  }
  await browser.close();
  r.check('B1', 'HTML injection', 'markup in announcements, roles, key names and user names is shown as text; nothing runs', ran.length === 0 && dialogs === 0, ran.join(', ') || '5 pages');
}

/** Time-based checks, run last: the lockout also blocks the address for a while. */
export async function slow(w: World) {
  const { r, base, admin } = w;
  await admin.call('/api/settings', { method: 'PUT', json: { values: { sessionIdleMinutes: 1 } } });
  const idle = new Client(base);
  await idle.login('olga', w.users.olga!.password);
  const busy = w.users.olga!.client;
  await busy.login('olga', w.users.olga!.password);
  for (let i = 0; i < 4; i++) {
    await sleep(20_000);
    await busy.call('/api/auth/session');
  }
  const i1 = (await idle.call('/api/auth/session')).status;
  const i2 = (await busy.call('/api/auth/session')).status;
  r.check('Y1', 'Sessions', 'with a 1-minute idle timeout, an idle session ends and an active one stays', i1 === 401 && i2 === 200, `idle ${i1}, active ${i2}`);
  await admin.login('admin', PW);
  await admin.call('/api/settings', { method: 'PUT', json: { values: { sessionIdleMinutes: null } } });
  const codes: number[] = [];
  for (let i = 0; i < 12; i++) codes.push((await new Client(base).login('olga', 'definitely the wrong password')).status);
  const right = (await new Client(base).login('olga', w.users.olga!.password)).status;
  r.check('Y2', 'Sign-in', 'repeated wrong passwords block the username, even the right password then', codes.includes(429) && right === 429, `${codes.join(',')} then ${right}`);
  const audit = JSON.stringify((await admin.call('/api/audit?pageSize=200')).data);
  r.check('Y3', 'Audit', 'failed sign-ins are audited without what was typed as the password', audit.includes('LOGIN_FAILED') && !audit.includes('definitely the wrong password'));
}
