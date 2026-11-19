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

import { isIP } from 'node:net';

/**
 * What kind of network an IP address belongs to (SEC-001). Only `public`
 * addresses are reachable by default; everything else needs the outbound
 * allowlist, and `metadata` is never reachable.
 */
export type AddressClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'metadata'
  | 'multicast'
  | 'unspecified'
  | 'reserved';

/** An address range: `base` and `bits` in the address's own family. */
interface Range {
  family: 4 | 6;
  base: bigint;
  bits: number;
  kind: AddressClass;
  note: string;
}

/** Parses a dotted-quad IPv4 address to a 32-bit number, or null. */
export function parseIPv4(text: string): bigint | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

/** Parses an IPv6 address (with `::`, an embedded IPv4 tail and an optional zone) to a 128-bit number, or null. */
export function parseIPv6(text: string): bigint | null {
  let h = text.replace(/^\[|\]$/g, '');
  const zone = h.indexOf('%');
  if (zone >= 0) h = h.slice(0, zone);
  if (isIP(h) !== 6) return null;
  // An IPv4 tail ("::ffff:10.0.0.1") becomes two hex groups.
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (v4) {
    const n = parseIPv4(v4[1]!);
    if (n === null) return null;
    h = `${h.slice(0, v4.index)}${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const [head = '', tail] = h.split('::');
  const left = head ? head.split(':') : [];
  const right = tail === undefined ? [] : tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill('0'), ...right];
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

function range(cidr: string, kind: AddressClass, note: string): Range {
  const [address = '', bits = ''] = cidr.split('/');
  const v4 = parseIPv4(address);
  const base = v4 ?? parseIPv6(address);
  if (base === null) throw new Error(`bad range ${cidr}`);
  return { family: v4 !== null ? 4 : 6, base, bits: Number(bits), kind, note };
}

/**
 * Special-purpose ranges (IANA IPv4/IPv6 special-purpose registries), most
 * specific first: the first match wins, so metadata addresses come before the
 * link-local range that contains them.
 */
const RANGES: readonly Range[] = [
  // Cloud metadata services (AWS, GCP, Azure, OpenStack, DigitalOcean; ECS task metadata; Alibaba; Oracle).
  range('169.254.169.254/32', 'metadata', 'cloud metadata service'),
  range('169.254.170.2/32', 'metadata', 'container metadata service'),
  range('169.254.169.123/32', 'metadata', 'cloud time service'),
  range('100.100.100.200/32', 'metadata', 'cloud metadata service'),
  range('192.0.0.192/32', 'metadata', 'cloud metadata service'),
  range('fd00:ec2::254/128', 'metadata', 'cloud metadata service'),
  range('fd00:ec2::23/128', 'metadata', 'cloud DNS service'),
  // IPv4
  range('0.0.0.0/8', 'unspecified', '"this network"'),
  range('10.0.0.0/8', 'private', 'private network'),
  range('100.64.0.0/10', 'private', 'carrier-grade NAT'),
  range('127.0.0.0/8', 'loopback', 'loopback'),
  range('169.254.0.0/16', 'link_local', 'link-local'),
  range('172.16.0.0/12', 'private', 'private network'),
  range('192.0.0.0/24', 'reserved', 'IETF protocol assignments'),
  range('192.0.2.0/24', 'reserved', 'documentation'),
  range('192.88.99.0/24', 'reserved', '6to4 relay anycast'),
  range('192.168.0.0/16', 'private', 'private network'),
  range('198.18.0.0/15', 'reserved', 'benchmarking'),
  range('198.51.100.0/24', 'reserved', 'documentation'),
  range('203.0.113.0/24', 'reserved', 'documentation'),
  range('224.0.0.0/4', 'multicast', 'multicast'),
  range('240.0.0.0/4', 'reserved', 'reserved'),
  // IPv6
  range('::/128', 'unspecified', 'unspecified'),
  range('::1/128', 'loopback', 'loopback'),
  range('100::/64', 'reserved', 'discard-only'),
  range('2001::/23', 'reserved', 'IETF protocol assignments'),
  range('2001:db8::/32', 'reserved', 'documentation'),
  range('3fff::/20', 'reserved', 'documentation'),
  range('fc00::/7', 'private', 'unique local'),
  range('fe80::/10', 'link_local', 'link-local'),
  range('fec0::/10', 'private', 'site-local'),
  range('ff00::/8', 'multicast', 'multicast'),
];

function inRange(r: Range, family: 4 | 6, value: bigint): boolean {
  if (r.family !== family) return false;
  const width = family === 4 ? 32 : 128;
  const shift = BigInt(width - r.bits);
  return value >> shift === r.base >> shift;
}

/**
 * The IPv4 address an IPv6 address stands for, if it is one of the forms that
 * reach IPv4 hosts: IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d),
 * NAT64 (64:ff9b::/96) and 6to4 (2002::/16). Classifying the embedded address
 * stops "::ffff:127.0.0.1" from passing as a public IPv6 address.
 */
export function embeddedIPv4(value: bigint): bigint | null {
  const top96 = value >> 32n;
  const low32 = value & 0xffffffffn;
  if (top96 === 0xffffn) return low32; // ::ffff:0:0/96
  if (top96 === 0n && low32 > 1n) return low32; // ::/96 (deprecated IPv4-compatible); ::, ::1 excluded
  if (top96 === 0x64ff9b0000000000000000n) return low32; // 64:ff9b::/96
  if (value >> 112n === 0x2002n) return (value >> 80n) & 0xffffffffn; // 2002:AABB:CCDD::/48
  return null;
}

export interface Classification {
  address: string;
  kind: AddressClass;
  /** A short human description of the range ("private network"), for error messages. */
  note: string;
}

/** Classifies an IP address (IPv4 or IPv6, with or without brackets). Not an IP: null. */
export function classifyAddress(address: string): Classification | null {
  const text = address.replace(/^\[|\]$/g, '');
  const v4 = parseIPv4(text);
  const family: 4 | 6 = v4 !== null ? 4 : 6;
  const value = v4 ?? parseIPv6(text);
  if (value === null) return null;
  if (family === 6) {
    const inner = embeddedIPv4(value);
    if (inner !== null) {
      const viaV4 = classifyValue(4, inner);
      // The embedded address decides, unless it is public and the wrapper range itself is special.
      if (viaV4.kind !== 'public') return { address, ...viaV4 };
    }
  }
  return { address, ...classifyValue(family, value) };
}

function classifyValue(family: 4 | 6, value: bigint): { kind: AddressClass; note: string } {
  for (const r of RANGES) if (inRange(r, family, value)) return { kind: r.kind, note: r.note };
  return { kind: 'public', note: 'public address' };
}

/** A parsed CIDR range or single address, for allowlists. */
export interface Cidr {
  family: 4 | 6;
  base: bigint;
  bits: number;
  text: string;
}

/** Parses "10.0.0.0/8", "fd00::/8" or a bare address. Null when invalid. */
export function parseCidr(text: string): Cidr | null {
  const [address = '', bitsText] = text.trim().split('/');
  const v4 = parseIPv4(address);
  const value = v4 ?? parseIPv6(address);
  if (value === null) return null;
  const family: 4 | 6 = v4 !== null ? 4 : 6;
  const max = family === 4 ? 32 : 128;
  const bits = bitsText === undefined ? max : /^\d{1,3}$/.test(bitsText) ? Number(bitsText) : NaN;
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  return { family, base: value, bits, text: text.trim() };
}

/** Whether an IP address is inside a CIDR range (IPv4-mapped IPv6 addresses match IPv4 ranges). */
export function cidrContains(cidr: Cidr, address: string): boolean {
  const text = address.replace(/^\[|\]$/g, '');
  const v4 = parseIPv4(text);
  let family: 4 | 6 = v4 !== null ? 4 : 6;
  let value = v4 ?? parseIPv6(text);
  if (value === null) return false;
  if (family === 6 && cidr.family === 4 && value >> 32n === 0xffffn) {
    family = 4;
    value &= 0xffffffffn;
  }
  if (family !== cidr.family) return false;
  const shift = BigInt((family === 4 ? 32 : 128) - cidr.bits);
  return value >> shift === cidr.base >> shift;
}
