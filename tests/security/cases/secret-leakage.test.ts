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

// SEC-027 corpus: stored secrets leaking or being planted.

import { describe, expect, test } from 'bun:test';
import type { ConfigurationDocument } from '@clawrouter/shared';
import { SETUP_TOKEN } from '../../support/harness.ts';
import { createHarness } from '../support.ts';

describe('secret leakage', () => {
  test('CASE-017: a mail password in an imported document is refused, not stored and not repeated', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const doc = ((await (await h.request('/api/configuration/export', { cookie: admin })).json()) as { data: ConfigurationDocument }).data;
    (doc.settings.mail as unknown as Record<string, unknown>) = { ...doc.settings.mail, host: 'smtp.example.test', password: 'planted-mail-password' };
    const res = await h.request('/api/configuration/import', { method: 'POST', cookie: admin, json: doc });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('planted-mail-password');
    expect(h.mail.get().host).toBe('');
    expect(JSON.stringify(h.db.all('SELECT * FROM settings'))).not.toContain('planted-mail-password');
  });

  test('CASE-018: the mail password and the setup token are never in an answer or a log', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const password = 'mail-password-canary-0123456789';
    expect((await h.request('/api/settings/mail', { method: 'PUT', cookie: admin, json: { host: 'smtp.example.test', port: 587, security: 'starttls', username: 'ada', from: 'cr@example.test', password } })).status).toBe(200);
    const answers = await Promise.all(['/api/settings/mail', '/api/settings', '/api/audit', '/api/logs', '/api/configuration/export', '/api/setup/status'].map(async (p) => (await h.request(p, { cookie: admin })).text()));
    const everything = JSON.stringify([answers, h.logs, h.db.all('SELECT * FROM audit_log')]);
    expect(everything).not.toContain(password);
    expect(everything).not.toContain(SETUP_TOKEN);
  });
});
