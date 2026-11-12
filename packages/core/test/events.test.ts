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
