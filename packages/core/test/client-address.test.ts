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

import { describe, expect, test } from 'bun:test';
import { clientAddress, loadConfig, parseTrustedProxies } from '../src/index.ts';

const none = parseTrustedProxies('').proxies;
const lb = parseTrustedProxies('10.0.0.0/8, 192.0.2.10, fd00::/8').proxies;

describe('client address behind proxies', () => {
  test('without trusted proxies, X-Forwarded-For is ignored (a client cannot choose its address)', () => {
    expect(clientAddress('203.0.113.9', '1.2.3.4', none)).toBe('203.0.113.9');
  });

  test('a request not from a trusted proxy keeps its socket address', () => {
    expect(clientAddress('203.0.113.9', '1.2.3.4', lb)).toBe('203.0.113.9');
  });

  test('from a trusted proxy, the right-most untrusted hop is the client', () => {
    expect(clientAddress('10.1.1.1', '198.51.100.4', lb)).toBe('198.51.100.4');
    // A client-supplied first entry cannot win: the proxy appended the real one.
    expect(clientAddress('10.1.1.1', '1.2.3.4, 198.51.100.4', lb)).toBe('198.51.100.4');
    // Several trusted hops are skipped.
    expect(clientAddress('10.1.1.1', '198.51.100.4, 192.0.2.10, 10.9.9.9', lb)).toBe('198.51.100.4');
  });

  test('IPv4-mapped IPv6 and IPv6 ranges', () => {
    expect(clientAddress('::ffff:10.1.1.1', '198.51.100.4', lb)).toBe('198.51.100.4');
    expect(clientAddress('::ffff:203.0.113.9', null, none)).toBe('203.0.113.9');
    expect(clientAddress('fd12::1', '2001:db8::7', lb)).toBe('2001:db8::7');
  });

  test('garbage in the header never becomes the client address', () => {
    expect(clientAddress('10.1.1.1', 'not-an-ip', lb)).toBe('10.1.1.1');
    expect(clientAddress('10.1.1.1', 'evil, 198.51.100.4', lb)).toBe('198.51.100.4');
    expect(clientAddress('10.1.1.1', '198.51.100.4, <script>', lb)).toBe('10.1.1.1');
  });

  test('configuration is validated', () => {
    expect(loadConfig({ CLAWROUTER_TRUSTED_PROXIES: '127.0.0.1, 10.0.0.0/8' }).server.trustedProxies).toEqual(['127.0.0.1', '10.0.0.0/8']);
    expect(() => loadConfig({ CLAWROUTER_TRUSTED_PROXIES: '10.0.0.0/33, proxy.local' })).toThrow('CLAWROUTER_TRUSTED_PROXIES');
    expect(loadConfig({}).server.trustedProxies).toEqual([]);
  });
});
