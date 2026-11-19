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
import { classifyAddress, createOutboundPolicy, parseAllowlist, parseIPv6 } from '../src/index.ts';

const kindOf = (address: string) => classifyAddress(address)?.kind;

describe('IP classifier (SEC-001)', () => {
  test.each([
    ['8.8.8.8', 'public'], ['1.1.1.1', 'public'], ['93.184.215.14', 'public'],
    ['127.0.0.1', 'loopback'], ['127.255.255.254', 'loopback'],
    ['10.1.2.3', 'private'], ['172.16.0.1', 'private'], ['172.31.255.255', 'private'], ['192.168.0.1', 'private'], ['100.64.0.1', 'private'],
    ['172.15.255.255', 'public'], ['172.32.0.0', 'public'],
    ['169.254.1.1', 'link_local'], ['169.254.169.254', 'metadata'], ['169.254.170.2', 'metadata'], ['100.100.100.200', 'metadata'], ['192.0.0.192', 'metadata'],
    ['0.0.0.0', 'unspecified'], ['0.1.2.3', 'unspecified'],
    ['224.0.0.1', 'multicast'], ['239.255.255.255', 'multicast'],
    ['240.0.0.1', 'reserved'], ['255.255.255.255', 'reserved'], ['192.0.2.1', 'reserved'], ['198.18.0.1', 'reserved'], ['203.0.113.9', 'reserved'],
    ['::1', 'loopback'], ['[::1]', 'loopback'], ['::', 'unspecified'],
    ['fc00::1', 'private'], ['fd12:3456::1', 'private'], ['fec0::1', 'private'],
    ['fe80::1', 'link_local'], ['fe80::1%eth0', 'link_local'], ['ff02::1', 'multicast'],
    ['fd00:ec2::254', 'metadata'], ['2001:db8::1', 'reserved'],
    ['2606:4700:4700::1111', 'public'], ['2001:4860:4860::8888', 'public'],
  ])('%s is %s', (address, kind) => {
    expect(kindOf(address)).toBe(kind as never);
  });

  test.each([
    ['::ffff:127.0.0.1', 'loopback'], ['::ffff:7f00:1', 'loopback'], ['::ffff:10.0.0.1', 'private'],
    ['::ffff:169.254.169.254', 'metadata'], ['::127.0.0.1', 'loopback'],
    ['64:ff9b::a9fe:a9fe', 'metadata'], ['64:ff9b::0a00:0001', 'private'],
    ['2002:7f00:0001::1', 'loopback'], ['2002:c0a8:0101::1', 'private'],
    ['::ffff:8.8.8.8', 'public'],
  ])('IPv6 forms of IPv4 addresses are judged by the IPv4 address: %s is %s', (address, kind) => {
    expect(kindOf(address)).toBe(kind as never);
  });

  test('not an IP address', () => {
    expect(classifyAddress('example.com')).toBeNull();
    expect(classifyAddress('1.2.3')).toBeNull();
    expect(classifyAddress('256.1.1.1')).toBeNull();
    expect(parseIPv6('1::2::3')).toBeNull();
  });

  // The URL parser turns every spelling of an IPv4 address into dotted quads, so the classifier sees them all.
  test.each(['http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://127.1/', 'http://[::ffff:127.0.0.1]/', 'http://[0:0:0:0:0:ffff:7f00:1]/'])(
    'alternative spelling %s is still loopback', (raw) => {
      const host = new URL(raw).hostname;
      expect(kindOf(host)).toBe('loopback');
    },
  );
});

describe('outbound policy', () => {
  const url = (raw: string) => new URL(raw);

  test('closed by default: https to public addresses only', () => {
    const p = createOutboundPolicy();
    expect(p.checkUrl(url('https://api.openai.com/v1'))).toBeNull();
    expect(p.checkAddresses(url('https://api.openai.com/v1'), ['104.18.7.192', '2606:4700::6812:7c0'])).toBeNull();
    expect(p.checkUrl(url('http://api.openai.com/v1'))).toContain('plain http');
    expect(p.checkUrl(url('https://127.0.0.1'))).toContain('loopback');
    expect(p.checkUrl(url('https://[::1]'))).toContain('loopback');
    expect(p.checkUrl(url('https://10.0.0.1'))).toContain('CLAWROUTER_OUTBOUND_ALLOWLIST');
    expect(p.checkUrl(url('https://0.0.0.0'))).toContain('this network');
    expect(p.checkUrl(url('file:///etc/passwd'))).toContain('http and https');
    expect(p.checkUrl(url('https://u:p@example.com'))).toContain('credentials');
  });

  test('a name resolving to a private address is refused', () => {
    const p = createOutboundPolicy();
    expect(p.checkAddresses(url('https://evil.example'), ['127.0.0.1'])).toContain('loopback');
    expect(p.checkAddresses(url('https://evil.example'), ['::ffff:10.0.0.5'])).toContain('private');
    expect(p.checkAddresses(url('https://evil.example'), [])).toContain('did not resolve');
  });

  test('every DNS answer must pass, not just the first', () => {
    const p = createOutboundPolicy();
    expect(p.checkAddresses(url('https://evil.example'), ['8.8.8.8', '127.0.0.1'])).toContain('127.0.0.1');
    expect(p.checkAddresses(url('https://evil.example'), ['2001:4860:4860::8888', 'fe80::1'])).toContain('link-local');
  });

  test('metadata services are never reachable, even with a catch-all allowlist', () => {
    const p = createOutboundPolicy(['0.0.0.0/0', '::/0', 'metadata.google.internal', '*.internal']);
    expect(p.checkUrl(url('http://169.254.169.254/latest/meta-data'))).toContain('never reachable');
    expect(p.checkUrl(url('http://metadata.google.internal/'))).toContain('never reachable');
    expect(p.checkUrl(url('http://[fd00:ec2::254]/'))).toContain('never reachable');
    expect(p.checkAddresses(url('http://innocent.example'), ['169.254.169.254'])).toContain('never reachable');
    expect(p.checkAddresses(url('http://innocent.example'), ['::ffff:169.254.169.254'])).toContain('never reachable');
    // Everything else the catch-all allows.
    expect(p.checkAddresses(url('http://innocent.example'), ['10.0.0.1'])).toBeNull();
  });

  test('allowlisted hostnames, suffixes and ranges', () => {
    const p = createOutboundPolicy('ollama, *.lan, 192.168.10.0/24, fd00:1::/32');
    expect(p.checkUrl(url('http://ollama:11434'))).toBeNull();
    expect(p.checkAddresses(url('http://ollama:11434'), ['172.18.0.4'])).toBeNull();
    expect(p.checkAddresses(url('http://gpu.lan'), ['10.9.9.9'])).toBeNull();
    expect(p.checkAddresses(url('http://lan'), ['10.9.9.9'])).toContain('private'); // the suffix needs a label in front
    expect(p.checkAddresses(url('http://box.example'), ['192.168.10.7'])).toBeNull();
    expect(p.checkAddresses(url('http://box.example'), ['192.168.11.7'])).toContain('private');
    expect(p.checkAddresses(url('https://box.example'), ['fd00:1::5'])).toBeNull();
    // http to a public address is allowed only when the destination is allowlisted.
    expect(p.checkAddresses(url('http://box.example'), ['8.8.8.8'])).toContain('plain http');
  });

  test('allowlist parsing reports invalid entries', () => {
    const parsed = parseAllowlist('localhost, 10.0.0.0/8, ::1, bad host, 10.0.0.0/33, http://x, *.lan');
    expect(parsed.entries).toEqual(['localhost', '10.0.0.0/8', '::1', '*.lan']);
    expect(parsed.invalid).toEqual(['bad host', '10.0.0.0/33', 'http://x']);
    expect(() => createOutboundPolicy('bad host')).toThrow('CLAWROUTER_OUTBOUND_ALLOWLIST');
  });
});
