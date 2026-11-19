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

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { buildMessage, sendMail, SmtpError, type SmtpConfig } from '../src/index.ts';
import { startMockSmtp } from '../../../tests/support/mock-smtp.ts';

const smtp = startMockSmtp();
afterAll(() => smtp.stop());
beforeEach(() => {
  smtp.messages.length = 0;
  smtp.refuseRecipients = false;
  smtp.authMechanisms = 'PLAIN LOGIN';
  smtp.credentials = { username: 'mailer', password: 'mail-secret-123' };
});

const config = (over: Partial<SmtpConfig> = {}): SmtpConfig => ({
  host: '127.0.0.1', port: smtp.port, security: 'none', username: 'mailer', password: 'mail-secret-123', from: 'ClawRouter <clawrouter@example.test>', timeoutMs: 3000, ...over,
});

describe('SMTP client', () => {
  test('signs in and delivers a UTF-8 plain-text message', async () => {
    await sendMail(config(), { to: 'Ada <ada@example.test>', subject: 'Your sign-in code — 123456', text: 'Code: 123456\n.\nBye' });
    expect(smtp.messages).toHaveLength(1);
    const m = smtp.messages[0]!;
    expect(m).toMatchObject({ from: 'clawrouter@example.test', to: ['ada@example.test'], subject: 'Your sign-in code — 123456' });
    expect(m.text).toBe('Code: 123456\n.\nBye');
  });

  test('AUTH LOGIN when PLAIN is not offered is handled the same way', async () => {
    smtp.authMechanisms = 'LOGIN';
    await sendMail(config(), { to: 'ada@example.test', subject: 's', text: 't' });
    expect(smtp.messages).toHaveLength(1);
  });

  test('wrong credentials, refused recipients and unreachable servers are reported without the password', async () => {
    const wrong = await sendMail(config({ password: 'not-it' }), { to: 'ada@example.test', subject: 's', text: 't' }).catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(SmtpError);
    expect((wrong as SmtpError).message).toContain('sign-in refused');
    expect((wrong as SmtpError).message).not.toContain('not-it');
    smtp.refuseRecipients = true;
    await expect(sendMail(config(), { to: 'ada@example.test', subject: 's', text: 't' })).rejects.toThrow('recipient refused: 550 mailbox unavailable');
    await expect(sendMail(config({ port: 1 }), { to: 'ada@example.test', subject: 's', text: 't' })).rejects.toThrow(SmtpError);
    // STARTTLS is required when asked for, never silently skipped.
    await expect(sendMail(config({ security: 'starttls' }), { to: 'ada@example.test', subject: 's', text: 't' })).rejects.toThrow('does not offer STARTTLS');
  });

  test('header injection is refused', () => {
    expect(() => buildMessage('a@b.test', { to: 'x@y.test\r\nBcc: z@z.test', subject: 's', text: 't' })).toThrow('single line');
    expect(() => buildMessage('a@b.test', { to: 'x@y.test', subject: 'hi\nBcc: z@z.test', text: 't' })).toThrow('single line');
  });
});
