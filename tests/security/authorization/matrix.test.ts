/*
 * ClawRouter - Self-hosted AI gateway and control platform
 * https://github.com/iant89/ClawRouter
 *
 * Copyright (C) 2026 Ian Thomas
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * in the LICENSE file for more details.
 */

// SEC-014: the committed authorization matrix matches the code, and every cell holds over HTTP.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiErrorBody, ApiSuccess, CreatedApiKey } from '@clawrouter/shared';
import { PERMISSIONS } from '@clawrouter/shared';
import { createHarness, type Harness } from '../../support/harness.ts';
import { buildMatrix, CONSOLE_ROLES, PRINCIPALS, renderJson, renderMarkdown, type Matrix, type MatrixRoute, type Principal } from './matrix.ts';

const root = join(import.meta.dir, '..', '..', '..');
const committed = JSON.parse(readFileSync(join(import.meta.dir, 'matrix.json'), 'utf8')) as Matrix;

describe('the committed matrix (SEC-014)', () => {
  test('matches the router and the built-in roles (run `bun run security:matrix` after a reviewed change)', () => {
    const actual = buildMatrix(createHarness().api.router.list());
    expect(renderJson(committed)).toBe(renderJson(actual));
    expect(readFileSync(join(root, 'docs/security/authorization-matrix.md'), 'utf8')).toBe(renderMarkdown(actual));
  });

  test('every route has an explicit, known policy; only a short, reviewed list is public', () => {
    for (const r of committed.routes) expect(['public', 'authenticated', 'api_key', 'mcp', ...PERMISSIONS]).toContain(r.access);
    // A new public route must be added here on purpose (AGENTS.md rule 4).
    expect(committed.routes.filter((r) => r.access === 'public').map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /api/health', 'GET /api/health/live', 'GET /api/health/ready', 'GET /api/setup/status',
      'POST /api/auth/login', 'POST /api/auth/login/email-code', 'POST /api/auth/login/verify', 'POST /api/auth/logout', 'POST /api/setup',
    ]);
  });

  test('console sessions never reach /v1 and API keys never reach /api', () => {
    for (const r of committed.routes) {
      if (r.access === 'public') continue;
      const v1 = r.path.startsWith('/v1/');
      for (const p of ['admin', 'operator', 'viewer', 'noRole'] as const) if (v1) expect([r.path, p, r.allowed[p]]).toEqual([r.path, p, 'N']);
      for (const p of ['apiKey', 'mcpKey'] as const) if (!v1) expect([r.path, p, r.allowed[p]]).toEqual([r.path, p, 'N']);
    }
  });

  test('administration stays with administrators', () => {
    const adminOnly = committed.routes.filter((r) => /^\/api\/(users|roles|settings|sessions|captures|announcements|configuration|api-keys)\b/.test(r.path));
    expect(adminOnly.length).toBeGreaterThan(30);
    for (const r of adminOnly) expect([r.path, r.allowed]).toEqual([r.path, { ...r.allowed, admin: 'Y', operator: 'N', viewer: 'N', noRole: 'N', anonymous: 'N' }]);
  });
});

// ---------------------------------------------------------------------------------------------
// Every cell over HTTP.

interface World { h: Harness; cookies: Record<string, string>; keys: Record<'apiKey' | 'mcpKey', string>; target: string }

async function world(): Promise<World> {
  const h = createHarness();
  const admin = await h.completeSetup();
  expect((await h.request('/api/settings', { method: 'PUT', cookie: admin, json: { values: { mcpEnabled: 1 } } })).status).toBe(200);
  const key = async (mcpAccess: boolean) => ((await (await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: `k${mcpAccess}`, mcpAccess } })).json()) as ApiSuccess<CreatedApiKey>).data.secret;
  const keys = { apiKey: await key(false), mcpKey: await key(true) };
  const cookies: Record<string, string> = {};
  for (const [p, role] of Object.entries(CONSOLE_ROLES)) {
    if (p !== 'admin') await h.addUser(p.toLowerCase(), role ? [role] : []);
    cookies[p] = p === 'admin' ? admin : await h.login(p.toLowerCase());
  }
  // Path ids point at a throw-away user, so routes that change or delete things hit nobody who matters.
  const target = (await h.addUser('target', ['VIEWER'])).id;
  return { h, cookies, keys, target };
}

/** Every principal is still signed in with the role it started with (an allowed call may have signed someone out). */
async function intact(w: World) {
  for (const [p, role] of Object.entries(CONSOLE_ROLES)) {
    const res = await w.h.request('/api/auth/session', { cookie: w.cookies[p] });
    if (res.status !== 200) return false;
    const roles = ((await res.json()) as ApiSuccess<{ roles: string[] }>).data.roles;
    if (JSON.stringify(roles) !== JSON.stringify(role ? [role] : [])) return false;
  }
  for (const k of ['apiKey', 'mcpKey'] as const) if ((await w.h.request('/v1/models', { headers: { authorization: `Bearer ${w.keys[k]}` } })).status !== 200) return false;
  return true;
}

function call(w: World, route: MatrixRoute, who: Principal) {
  const path = route.path.replace(/:[a-z]+/gi, w.target);
  const json = route.method === 'GET' || route.method === 'DELETE' ? undefined : { userId: w.target, roles: ['VIEWER'] };
  const headers: Record<string, string> = who === 'apiKey' || who === 'mcpKey' ? { authorization: `Bearer ${w.keys[who]}` } : {};
  const cookie = who in CONSOLE_ROLES ? w.cookies[who] : undefined;
  w.h.logs.length = 0;
  return w.h.request(path, { method: route.method, json, headers, cookie });
}

/** Refused by the router's access check, rather than by the handler. */
async function refusedByAccessCheck(w: World, route: MatrixRoute, res: Response): Promise<string | null> {
  if (res.status === 401) {
    const body = (await res.clone().json()) as ApiErrorBody;
    return body.error?.code === 'AUTHENTICATION_ERROR' || (body.error as { type?: string })?.type === 'authentication_error' || route.path.startsWith('/v1/') ? '401' : null;
  }
  if (res.status === 403 && w.h.logs.some((l) => l.msg === 'access denied')) return '403 permission';
  if (res.status === 403 && route.access === 'mcp') return '403 no MCP access';
  return null;
}

// Least privileged first, administrator last, so one principal's allowed call rarely affects the next.
const ORDER: Principal[] = ['anonymous', 'apiKey', 'mcpKey', 'noRole', 'viewer', 'operator', 'admin'];

describe('every route as every principal (SEC-014)', () => {
  test('ORDER covers every principal', () => expect([...ORDER].sort()).toEqual([...PRINCIPALS].sort()));

  test('refused cells are refused by the access check, allowed cells pass it', async () => {
    let w = await world();
    const failures: string[] = [];
    for (const route of committed.routes) {
      for (const who of ORDER) {
        if (!(await intact(w))) w = await world();
        const res = await call(w, route, who);
        const refused = await refusedByAccessCheck(w, route, res);
        const expected = route.allowed[who];
        // Public handlers answer 401 for their own reasons (a wrong password): only refusals are checked there.
        if (route.access === 'public') continue;
        if (expected === 'N' && !refused) failures.push(`${route.method} ${route.path} as ${who}: expected refusal, got ${res.status}`);
        if (expected === 'Y' && refused) failures.push(`${route.method} ${route.path} as ${who}: expected access, got ${refused}`);
        if (expected === 'N' && refused) {
          // Who is told what: no credential of the right kind is 401; the wrong permission is 403.
          const wantStatus = who === 'anonymous' || route.path.startsWith('/v1/') !== (who === 'apiKey' || who === 'mcpKey') ? 401 : 403;
          if (res.status !== wantStatus) failures.push(`${route.method} ${route.path} as ${who}: expected ${wantStatus}, got ${res.status}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 60_000);

  test('MCP switched off: /v1/mcp does not exist for anyone, a key with MCP access included', async () => {
    const w = await world();
    await w.h.request('/api/settings', { method: 'PUT', cookie: w.cookies.admin, json: { values: { mcpEnabled: 0 } } });
    const mcp = committed.routes.find((r) => r.access === 'mcp')!;
    for (const who of PRINCIPALS) expect([who, (await call(w, mcp, who)).status]).toEqual([who, 404]);
  });
});
