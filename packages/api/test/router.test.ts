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
import { AppError } from '@clawrouter/core';
import { Router, type Handler } from '../src/index.ts';

const h = (name: string): Handler => () => new Response(name);

describe('Router', () => {
  const router = new Router()
    .get('/api/providers', 'providers.read', h('list'))
    .post('/api/providers', 'providers.write', h('create'))
    .get('/api/providers/:id', 'providers.read', h('get'))
    .post('/api/providers/:id/test', 'providers.write', h('test'))
    .get('/files/*', 'public', h('files'));

  test('matches static and parameter routes', async () => {
    expect(await (await router.match('GET', '/api/providers').handler({} as never)).text()).toBe('list');
    const m = router.match('POST', '/api/providers/p%201/test');
    expect(m.params).toEqual({ id: 'p 1' });
    expect(m.access).toBe('providers.write');
  });

  test('trailing slashes are ignored', () => {
    expect(router.match('GET', '/api/providers/').params).toEqual({});
  });

  test('wildcard tail', () => {
    expect(() => router.match('GET', '/files/a/b/c')).not.toThrow();
  });

  test('HEAD is served by GET routes', () => {
    expect(() => router.match('HEAD', '/api/providers')).not.toThrow();
  });

  test('unknown path -> NOT_FOUND', () => {
    expect(() => router.match('GET', '/api/nope')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  test('wrong method -> METHOD_NOT_ALLOWED with Allow header', () => {
    try {
      router.match('DELETE', '/api/providers');
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('METHOD_NOT_ALLOWED');
      expect((error as AppError).headers.Allow).toBe('GET, HEAD, POST');
    }
  });

  test('malformed percent-encoding does not match', () => {
    expect(() => router.match('GET', '/api/providers/%E0%A4%A')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});
