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

// SEC-027 corpus: reaching what a principal's permissions do not allow.

import { describe, expect, test } from 'bun:test';
import { PERMISSIONS, type ConfigurationDocument } from '@clawrouter/shared';
import { createHarness } from '../support.ts';

describe('authorization bypass', () => {
  test.each([
    '/api/users', '/API/users', '/api/Users', '/api/users/', '/api//users', '/api/./users', '/api/users/.', '/api/x/../users',
    '/api/%75sers', '/api/users%2f', '/api/users?x=/api/health', '/api/users#x', '/api/users;x',
  ])('CASE-010: %s is not readable by a Viewer or anonymously', async (path) => {
    const h = createHarness();
    await h.completeSetup();
    await h.addUser('vera', ['VIEWER']);
    const vera = await h.login('vera');
    for (const cookie of [null, vera]) {
      const res = await h.request(path, { cookie });
      const text = await res.text();
      expect([path, res.status < 400]).toEqual([path, false]);
      expect(text).not.toContain('"username":"admin"');
    }
  });

  test('CASE-011: an import cannot change a role holding permissions the importer lacks', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    h.authz.createRole({ id: 'u', username: 'admin' }, { name: 'Builders', description: '', permissions: ['providers.write', 'providers.read'] }, { ip: null });
    const doc = ((await (await h.request('/api/configuration/export', { cookie: admin })).json()) as { data: ConfigurationDocument }).data;
    doc.roles = [{ name: 'Builders', description: 'taken over', permissions: ['providers.read'] }];
    const importer = { id: 'imp', username: 'importer', permissions: new Set<string>(['settings.read', 'settings.write', 'roles.read', 'roles.write', 'providers.read', 'models.read', 'routing.read', 'rate_limits.read']) };
    expect(h.configuration.plan(importer, doc).missingPermissions).toContain('providers.write');
    await expect(h.configuration.apply(importer, doc, { ip: null })).rejects.toThrow(/providers.write/);
    expect(h.authz.listRoles().find((r) => r.name === 'Builders')).toMatchObject({ description: '', permissions: expect.arrayContaining(['providers.write']) });
  });

  test('CASE-012: a Viewer cannot give themselves a role, create one, or change their permissions', async () => {
    const h = createHarness();
    await h.completeSetup();
    const vera = await h.addUser('vera', ['VIEWER']);
    const cookie = await h.login('vera');
    expect((await h.request(`/api/users/${vera.id}/roles`, { method: 'PUT', cookie, json: { roles: ['ADMINISTRATOR'] } })).status).toBe(403);
    expect((await h.request('/api/roles', { method: 'POST', cookie, json: { name: 'Mine', description: '', permissions: [...PERMISSIONS].slice(0, 3) } })).status).toBe(403);
    expect((await h.request('/api/users/me', { method: 'PATCH', cookie, json: { roles: ['ADMINISTRATOR'] } })).status).toBeGreaterThanOrEqual(400);
    expect(h.authz.listRoles().filter((r) => !r.builtIn)).toEqual([]);
    const session = (await (await h.request('/api/auth/session', { cookie })).json()) as { data: { permissions: string[] } };
    expect(session.data.permissions).not.toContain('users.write');
  });
});
