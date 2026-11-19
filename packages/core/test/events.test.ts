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
import { createEventBus, createLogger, type LogRecord } from '../src/index.ts';

describe('event bus', () => {
  test('delivers typed payloads and supports unsubscribe', () => {
    const bus = createEventBus();
    const seen: string[] = [];
    const off = bus.on('settings.changed', (p) => { seen.push(p.key); });
    bus.emit('settings.changed', { key: 'a' });
    off();
    bus.emit('settings.changed', { key: 'b' });
    expect(seen).toEqual(['a']);
    expect(bus.listenerCount('settings.changed')).toBe(0);
  });

  test('a failing listener does not affect others and is logged', async () => {
    const records: LogRecord[] = [];
    const bus = createEventBus(createLogger({ sink: (r) => records.push(r) }));
    const seen: string[] = [];
    bus.on('settings.changed', () => { throw new Error('sync fail'); });
    bus.on('settings.changed', async () => { throw new Error('async fail'); });
    bus.on('settings.changed', (p) => { seen.push(p.key); });
    expect(() => bus.emit('settings.changed', { key: 'k' })).not.toThrow();
    await Bun.sleep(0);
    expect(seen).toEqual(['k']);
    expect(records.filter((r) => r.msg === 'event listener failed')).toHaveLength(2);
  });
});
