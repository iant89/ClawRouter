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
import { createLogger, redact, REDACTED, type LogRecord } from '../src/index.ts';

function capture(level: 'debug' | 'info' = 'debug') {
  const records: LogRecord[] = [];
  const lines: string[] = [];
  const log = createLogger({ level, sink: (r, l) => { records.push(r); lines.push(l); }, now: () => new Date('2026-01-01T00:00:00Z') });
  return { log, records, lines };
}

describe('logger', () => {
  test('writes structured JSON records', () => {
    const { log, lines } = capture();
    log.info('hello', { component: 'test', n: 1 });
    expect(JSON.parse(lines[0]!)).toEqual({ time: '2026-01-01T00:00:00.000Z', level: 'info', msg: 'hello', component: 'test', n: 1 });
  });

  test('filters below the configured level', () => {
    const { log, records } = capture('info');
    log.debug('hidden');
    log.warn('shown');
    expect(records.map((r) => r.msg)).toEqual(['shown']);
  });

  test('child loggers add bindings', () => {
    const { log, records } = capture();
    log.child({ requestId: 'req_1' }).info('x');
    expect(records[0]!.requestId).toBe('req_1');
  });

  test('never writes secrets', () => {
    const { log, lines } = capture();
    log.info('provider configured', {
      apiKey: 'sk-live-123',
      headers: { Authorization: 'Bearer abc', 'content-type': 'json' },
      user: { password: 'hunter2', name: 'ian' },
      sessionToken: 't',
    });
    const line = lines[0]!;
    for (const secret of ['sk-live-123', 'Bearer abc', 'hunter2']) expect(line).not.toContain(secret);
    expect(line).toContain('ian');
  });
});

describe('redact', () => {
  test('handles cycles, errors and dates', () => {
    const a: Record<string, unknown> = { when: new Date('2026-01-01T00:00:00Z') };
    a.self = a;
    a.error = Object.assign(new Error('bad'), { cause: { token: 'x' } });
    const out = redact(a) as Record<string, unknown>;
    expect(out.self).toBe('[Circular]');
    expect(out.when).toBe('2026-01-01T00:00:00.000Z');
    expect((out.error as { cause: { token: string } }).cause.token).toBe(REDACTED);
  });
});
