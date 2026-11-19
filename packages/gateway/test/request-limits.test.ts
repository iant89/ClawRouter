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
import { costPeriod } from '@clawrouter/rate-limits';
import { imageSize, jsonDepthExceeds } from '../src/request-limits.ts';

describe('imageSize reads the header of every accepted image type', () => {
  test('PNG', () => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
    b.writeUInt32BE(640, 16);
    b.writeUInt32BE(480, 20);
    expect(imageSize(b)).toEqual({ width: 640, height: 480 });
  });

  test('GIF', () => {
    const b = Buffer.from('GIF89a\x20\x03\x58\x02\x00\x00', 'latin1');
    expect(imageSize(b)).toEqual({ width: 800, height: 600 });
  });

  test('JPEG, after an APP segment', () => {
    const app = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
    const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(imageSize(Buffer.from([0xff, 0xd8, ...app, ...sof]))).toEqual({ width: 1920, height: 1080 });
  });

  test('WebP (VP8X)', () => {
    const b = Buffer.alloc(30);
    b.write('RIFF', 0, 'latin1');
    b.write('WEBPVP8X', 8, 'latin1');
    b.writeUIntLE(1023, 24, 3);
    b.writeUIntLE(767, 27, 3);
    expect(imageSize(b)).toEqual({ width: 1024, height: 768 });
  });

  test('anything else is unreadable', () => {
    expect(imageSize(Buffer.from('hello world, not an image'))).toBeNull();
    expect(imageSize(Buffer.from([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))).toBeNull();
  });
});

describe('jsonDepthExceeds', () => {
  test('counts objects and arrays, not brackets in strings or escaped quotes', () => {
    expect(jsonDepthExceeds('{"a":[1,{"b":2}]}', 3)).toBe(false);
    expect(jsonDepthExceeds('{"a":[1,{"b":2}]}', 2)).toBe(true);
    expect(jsonDepthExceeds('{"a":"[[[[{{{{"}', 1)).toBe(false);
    expect(jsonDepthExceeds('{"a":"\\"[[[["}', 1)).toBe(false);
    expect(jsonDepthExceeds('[[],[],[],[]]', 2)).toBe(false);
  });
});

describe('costPeriod', () => {
  test('UTC hour, day and month', () => {
    const t = Date.parse('2026-02-28T23:30:00.000Z');
    expect(costPeriod('hour', t)).toEqual({ start: new Date('2026-02-28T23:00:00.000Z'), end: new Date('2026-03-01T00:00:00.000Z') });
    expect(costPeriod('day', t)).toEqual({ start: new Date('2026-02-28T00:00:00.000Z'), end: new Date('2026-03-01T00:00:00.000Z') });
    expect(costPeriod('month', t)).toEqual({ start: new Date('2026-02-01T00:00:00.000Z'), end: new Date('2026-03-01T00:00:00.000Z') });
    expect(costPeriod('month', Date.parse('2026-12-31T23:59:59.000Z')).end).toEqual(new Date('2027-01-01T00:00:00.000Z'));
  });
});
